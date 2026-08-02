import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  Broom,
  CalendarBlank,
  CaretDown,
  CheckCircle,
  ClockCountdown,
  Cloud,
  Cube,
  Database,
  DesktopTower,
  GithubLogo,
  GitBranch,
  HardDrives,
  IdentificationCard,
  Key,
  ListDashes,
  MagnifyingGlass,
  Package,
  ShieldCheck,
  Stack,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

const classifications = {
  active: { label: "使用中", color: "var(--active)" },
  protected: { label: "受保护", color: "var(--protected)" },
  retained: { label: "保留/待确认", color: "var(--retained)" },
  reclaimable: { label: "可安全清理", color: "var(--reclaimable)" },
};

const barMeta = {
  worktree: { label: "Worktrees", caption: "本地工作区与分支", Icon: GitBranch },
  image: { label: "Docker Images", caption: "唯一层占用与容器引用", Icon: Package },
  volume: { label: "Docker Volumes", caption: "真实占用与挂载关系", Icon: Database },
  cache: { label: "Build Cache", caption: "构建缓存", Icon: Stack },
  pull_request: { label: "Pull Requests", caption: "Open、Draft、Merged 与 Closed", Icon: GitBranch },
  artifact: { label: "Actions Artifacts", caption: "工作流制品与过期状态", Icon: Package },
  actions_cache: { label: "Actions Cache", caption: "分支与 Pull Request 构建缓存", Icon: Stack },
  workflow_run: { label: "Workflow Runs", caption: "CI 执行状态与结果", Icon: ListDashes },
};

const sourceIcons = { local: DesktopTower, server: Cloud, github: GithubLogo };

function formatBytes(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(Number(value)) / Math.log(1024)), units.length - 1);
  const amount = Number(value) / 1024 ** exponent;
  return `${amount >= 100 ? amount.toFixed(0) : amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[exponent]}`;
}

function formatMetric(bar, value) {
  return bar.unit === "count" ? `${Math.round(value)} 个` : formatBytes(value);
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function assetMetric(asset) {
  if (asset.type === "pull_request") return `${asset.headRef || "unknown"} → ${asset.baseRef || "unknown"}`;
  if (asset.type === "workflow_run") return formatTime(asset.updatedAt || asset.createdAt);
  return formatBytes(asset.sizeBytes);
}

function metricHeading(type) {
  if (type === "pull_request") return "分支";
  if (type === "workflow_run") return "更新时间";
  return "规模";
}

function createBridge() {
  if (window.parent === window) return null;
  let rpcId = 0;
  const pending = new Map();
  const listeners = new Set();
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.jsonrpc !== "2.0") return;
    const message = event.data;
    if (typeof message.id === "number") {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(message.error);
      else item.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result") listeners.forEach((listener) => listener(message.params));
  }, { passive: true });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++rpcId;
    pending.set(id, { resolve, reject });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
  const ready = request("ui/initialize", {
    appInfo: { name: "runtime-asset-dashboard", version: "0.2.0" },
    appCapabilities: {},
    protocolVersion: "2026-01-26",
  }).then(() => window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*"));
  return {
    onResult(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async call(name, args) { await ready; return request("tools/call", { name, arguments: args }); },
  };
}

const bridge = createBridge();

async function callTool(name, args = {}) {
  if (bridge) return bridge.call(name, args);
  const routes = {
    open_runtime_dashboard: ["GET", `/api/dashboard?scope=${encodeURIComponent(args.scope || "project")}&source=${encodeURIComponent(args.source || "local")}&project=${encodeURIComponent(args.project || "all")}`],
    preview_cleanup: ["POST", "/api/cleanup-preview"],
    execute_cleanup: ["POST", "/api/cleanup-execute"],
    save_cleanup_schedule: ["POST", "/api/schedule"],
  };
  const [method, path] = routes[name];
  const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? JSON.stringify(args) : undefined });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || payload.error || "请求失败");
  return { structuredContent: payload };
}

function EmptyState({ source, error }) {
  return (
    <div className="empty-state">
      <Cloud size={34} weight="duotone" />
      <strong>{error ? `${source?.label || "远程环境"} 读取失败` : `${source?.label || "远程环境"} 尚未加载快照`}</strong>
      <span>{error || "连接配置已经保留；没有远程快照时不会用本地数据冒充。"}</span>
    </div>
  );
}

function SegmentBar({ bar, selected, onSelect }) {
  const meta = barMeta[bar.type];
  const Icon = meta.Icon;
  const segments = [
    ["active", bar.activeBytes],
    ["protected", bar.protectedBytes],
    ["retained", bar.retainedBytes],
    ["reclaimable", bar.reclaimableBytes],
  ];
  const total = Math.max(1, segments.reduce((sum, [, value]) => sum + Number(value || 0), 0));
  return (
    <button className={`asset-band ${selected ? "is-selected" : ""}`} onClick={() => onSelect(bar.type)} type="button">
      <span className="band-icon"><Icon size={29} weight="duotone" /></span>
      <span className="band-name"><strong>{meta.label}</strong><small>{meta.caption}</small></span>
      <span className="band-visual">
        <span className="band-track" aria-label={`${meta.label} 容量分类`}>
          {segments.map(([kind, value]) => {
            const width = Number(value || 0) > 0 ? Math.max(3, (Number(value) / total) * 100) : 0;
            return <span key={kind} className={`segment segment-${kind}`} style={{ width: `${width}%` }} title={`${classifications[kind].label}: ${formatMetric(bar, value)}`} />;
          })}
          {segments.every(([, value]) => Number(value || 0) === 0) && <span className="segment-empty">暂无数据</span>}
        </span>
        <span className="band-stats">
          <span><i className="dot dot-active" />使用中 {formatMetric(bar, bar.activeBytes)}</span>
          <span><i className="dot dot-protected" />受保护 {formatMetric(bar, bar.protectedBytes)}</span>
          <span><i className="dot dot-retained" />待确认 {formatMetric(bar, bar.retainedBytes)}</span>
          <span className="safe"><i className="dot dot-reclaimable" />可清理 {formatMetric(bar, bar.reclaimableBytes)}</span>
        </span>
      </span>
      <span className="band-total"><strong>{bar.unit === "count" ? `${bar.count} 个` : formatBytes(bar.totalBytes)}</strong><small>{bar.count} 项资产</small></span>
    </button>
  );
}

function CleanupModal({ preview, loading, onClose, onConfirm }) {
  if (!preview) return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="cleanup-title">
        <button className="icon-button modal-close" type="button" onClick={onClose} aria-label="关闭"><X size={20} /></button>
        <div className="modal-kicker"><Broom size={22} weight="duotone" />精确清理预览</div>
        <h2 id="cleanup-title">预计释放 {formatBytes(preview.totalBytes)}</h2>
        <p>{preview.policy || "只包含服务端复核后仍满足安全条件的资产。受保护和归属未知的资产不会进入清单。"}</p>
        <div className="preview-summary"><span>{preview.allowlist.length} 项候选</span><span>{preview.protectedCount} 项受保护</span><span>10 分钟内有效</span></div>
        <div className="preview-list">
          {preview.allowlist.length === 0 ? <div className="preview-empty"><ShieldCheck size={26} />当前没有满足安全条件的清理候选</div> : preview.allowlist.map((item) => (
            <div className="preview-row" key={`${item.type}-${item.id}`}><span><strong>{item.name}</strong><small>{item.type} · {item.project}</small></span><b>{formatBytes(item.sizeBytes)}</b></div>
          ))}
        </div>
        <div className="modal-actions"><button className="button secondary" type="button" onClick={onClose}>取消</button><button className="button danger" type="button" disabled={loading || preview.allowlist.length === 0} onClick={onConfirm}>{loading ? "正在清理…" : `确认清理 ${preview.allowlist.length} 项`}</button></div>
      </section>
    </div>
  );
}

function ScheduleModal({ schedule, onClose, onSave }) {
  const [form, setForm] = useState(schedule);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal schedule-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-title">
        <button className="icon-button modal-close" type="button" onClick={onClose} aria-label="关闭"><X size={20} /></button>
        <div className="modal-kicker"><CalendarBlank size={22} weight="duotone" />定时维护</div>
        <h2 id="schedule-title">设置自动盘点计划</h2>
        <p>计划只生成清理预览和空间报告，不会无人值守删除资产。</p>
        <label className="switch-row"><span><strong>启用定时盘点</strong><small>按计划刷新分类和可回收空间</small></span><input type="checkbox" checked={Boolean(form.enabled)} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /></label>
        <div className="form-grid">
          <label>频率<select value={form.cadence} onChange={(event) => setForm({ ...form, cadence: event.target.value })}><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option></select></label>
          <label>执行日<select value={form.day} onChange={(event) => setForm({ ...form, day: event.target.value })}><option value="sunday">周日</option><option value="monday">周一</option><option value="first">每月 1 日</option></select></label>
          <label>时间<input type="time" value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} /></label>
        </div>
        <div className="modal-actions"><button className="button secondary" type="button" onClick={onClose}>取消</button><button className="button primary" type="button" onClick={() => onSave(form)}>保存计划</button></div>
      </section>
    </div>
  );
}

export function App() {
  const [dashboard, setDashboard] = useState(null);
  const [source, setSource] = useState("local");
  const [project, setProject] = useState("all");
  const [selectedType, setSelectedType] = useState("image");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const acceptResult = useCallback((result) => {
    const content = result?.structuredContent || result;
    if (content?.dashboard) {
      setDashboard(content.dashboard);
      if (content.dashboard.selectedSource) setSource(content.dashboard.selectedSource);
      if (content.dashboard.selectedProject) setProject(content.dashboard.selectedProject);
    }
    if (content?.preview) setPreview(content.preview);
    if (content?.schedule) setDashboard((current) => current ? { ...current, schedule: content.schedule } : current);
    if (content?.cleanup) {
      const removed = content.cleanup.results.filter((item) => item.status === "removed").length;
      const reclaimed = content.cleanup.results.reduce((sum, item) => sum + Number(item.reclaimedBytes ?? (item.status === "removed" ? item.sizeBytes : 0) ?? 0), 0);
      setNotice(`清理完成：已移除 ${removed} 项，预计释放 ${formatBytes(reclaimed)}`);
      setPreview(null);
    }
  }, []);

  const refresh = useCallback(async (next = {}) => {
    setLoading(true);
    try {
      const result = await callTool("open_runtime_dashboard", { scope: "project", source: next.source || source, project: next.project || project });
      acceptResult(result);
    } catch (error) {
      setNotice(`刷新失败：${error.message || error}`);
    } finally { setLoading(false); }
  }, [acceptResult, project, source]);

  useEffect(() => { refresh(); }, []);
  useEffect(() => bridge?.onResult(acceptResult), [acceptResult]);

  const selectSource = (next) => {
    setSource(next);
    setSelectedType(next === "github" ? "pull_request" : "image");
    if (next !== "local") {
      setDashboard((current) => current ? {
        ...current,
        selectedSource: next,
        selectedProject: project,
        host: "等待远程快照",
        disk: { totalBytes: 0, freeBytes: 0 },
        bars: [],
        assets: [],
        events: [],
      } : current);
    }
    refresh({ source: next, project });
  };
  const selectProject = (next) => {
    const nextProject = (dashboard?.projectOptions || []).find((item) => item.id === next);
    setProject(next);
    setSource("local");
    setSelectedType("image");
    setDashboard((current) => current ? {
      ...current,
      selectedProject: next,
      selectedSource: "local",
      disk: { totalBytes: 0, freeBytes: 0 },
      sources: current.sources.filter((item) => item.id === "local" || item.id === "github").map((item) => ({
        ...item,
        detail: item.id === "github" ? (nextProject?.repository || next) : (nextProject?.label || next),
      })),
      bars: [],
      assets: [],
      events: [],
    } : current);
    refresh({ project: next, source: "local" });
  };

  const visibleAssets = useMemo(() => (dashboard?.assets || []).filter((asset) => asset.type === selectedType && `${asset.name} ${asset.project} ${asset.status}`.toLowerCase().includes(query.toLowerCase())).slice(0, 18), [dashboard, query, selectedType]);
  const totalFootprint = (dashboard?.bars || []).filter((item) => item.unit !== "count").reduce((sum, item) => sum + Number(item.totalBytes || 0), 0);
  const totalReclaimable = (dashboard?.bars || []).reduce((sum, item) => sum + Number(item.reclaimableBytes || 0), 0);
  const protectedCount = (dashboard?.assets || []).filter((asset) => asset.classification === "protected").length;
  const openPullCount = (dashboard?.assets || []).filter((asset) => asset.type === "pull_request" && ["open", "draft"].includes(asset.status)).length;
  const selectedSource = dashboard?.sources?.find((item) => item.id === source);
  const snapshotOnline = source === "local" || dashboard?.remoteSnapshotAvailable;
  const effectiveProject = dashboard?.selectedProject || project;
  const projectOptions = dashboard?.projectOptions || (dashboard?.projects || []).map((id) => ({ id, label: id, repository: id }));
  const selectedProjectOption = projectOptions.find((item) => item.id === effectiveProject);
  const connection = selectedSource?.connection;
  const diskTotal = Number(dashboard?.disk?.totalBytes || 0);
  const diskFree = Number(dashboard?.disk?.freeBytes || 0);
  const diskUsed = Math.max(0, diskTotal - diskFree);
  const diskUsage = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : Number.NaN;
  const diskLevel = diskUsage >= 90 ? "critical" : diskUsage >= 80 ? "warning" : "healthy";

  const requestPreview = async () => {
    setLoading(true);
    try { acceptResult(await callTool("preview_cleanup", { source, project: effectiveProject, types: ["container", "image", "volume", "cache", "artifact", "actions_cache"] })); }
    catch (error) { setNotice(`预览失败：${error.message || error}`); }
    finally { setLoading(false); }
  };
  const confirmCleanup = async () => {
    setLoading(true);
    try { acceptResult(await callTool("execute_cleanup", { token: preview.token, confirmed: true })); await refresh(); }
    catch (error) { setNotice(`清理失败：${error.message || error}`); }
    finally { setLoading(false); }
  };
  const saveSchedule = async (form) => {
    try { acceptResult(await callTool("save_cleanup_schedule", form)); setScheduleOpen(false); setNotice("定时盘点计划已保存"); }
    catch (error) { setNotice(`保存失败：${error.message || error}`); }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><HardDrives size={26} weight="duotone" /></span><span><strong>Runtime Assets</strong><small>跨项目运行资产台</small></span></div>
        <label className="project-select"><span>当前项目（全局）</span><select aria-label="当前项目" value={effectiveProject} onChange={(event) => selectProject(event.target.value)}>{projectOptions.map((item) => <option value={item.id} key={item.id}>{item.label} · {item.repository}</option>)}</select><CaretDown size={16} /></label>
        <nav className="source-list" aria-label="数据源">
          {dashboard?.sources?.map((item) => {
            const Icon = sourceIcons[item.kind];
            return <button type="button" className={`source-card ${source === item.id ? "is-active" : ""}`} onClick={() => selectSource(item.id)} key={item.id}><span className="source-icon"><Icon size={24} weight="duotone" /></span><span><strong>{item.label}</strong><small>{item.detail}</small></span><i className={`status-dot status-${item.status}`} /></button>;
          })}
        </nav>
        <div className="sidebar-note"><ShieldCheck size={18} weight="fill" /><span><strong>安全分类已启用</strong><small>{source === "github" ? "PR 与 Workflow 只读；仅过期制品和失效缓存可清理。" : "未知卷默认保护，不进入自动清理。"}</small></span></div>
      </aside>

      <main className="dashboard">
        <header className="topbar">
          <div><div className="eyebrow">RUNTIME ASSET TRACKER</div><h1>运行资产控制台</h1><p>{selectedProjectOption?.label || effectiveProject} · {selectedSource?.label || "Local"} · {dashboard?.host || "正在连接"}</p></div>
          <div className="top-actions"><span className={`live-pill ${loading ? "loading" : ""} ${!snapshotOnline ? "offline" : ""}`}><i />{loading ? "正在刷新" : snapshotOnline ? (source === "local" ? "实时账本在线" : "安全连接在线") : "快照不可用"}</span><button className="icon-button" onClick={() => refresh()} type="button" aria-label="刷新"><ArrowClockwise size={20} className={loading ? "spin" : ""} /></button></div>
        </header>

        {selectedSource?.kind === "server" && <section className="server-summary">
          <article className="connection-card card">
            <div className="connection-title"><span className="metric-icon blue"><IdentificationCard size={22} /></span><span><small>项目绑定的连接身份</small><strong>{connection?.instanceId || "实例待登记"}</strong></span><span className={`credential-state credential-${connection?.credentialStatus || "unknown"}`}><Key size={14} />{connection?.credentialStatus === "configured" ? "凭据引用已配置" : "凭据待配置"}</span></div>
            <dl className="connection-grid">
              <div><dt>AWS Account ID</dt><dd>{connection?.accountId || "待登记"}</dd></div>
              <div><dt>IAM 用户 / 身份</dt><dd>{connection?.iamPrincipal || "待登记"}</dd></div>
              <div><dt>区域 / 可用区</dt><dd>{connection?.region || "待登记"} / {connection?.availabilityZone || "待登记"}</dd></div>
              <div><dt>主机 / 登录用户</dt><dd>{connection?.host || "待登记"} / {connection?.osUser || "待登记"}</dd></div>
              <div><dt>连接方式</dt><dd>{connection?.method || "待登记"}</dd></div>
              <div><dt>凭据引用</dt><dd>{connection?.credentialProvider || "系统凭据库"} · {connection?.profile || "待登记"}</dd></div>
              <div className="connection-wide"><dt>应用目录</dt><dd>{connection?.appPath || "待登记"}</dd></div>
            </dl>
            <p className="credential-note">这里只保存非敏感身份和凭据别名；私钥、密码、Access Key 与会话令牌不会进入项目配置、GitHub 或事件账本。</p>
          </article>
          <article className={`disk-card card disk-${diskLevel}`}>
            <div className="disk-title"><span><small>EC2 根盘容量</small><strong>{Number.isFinite(diskUsage) ? formatPercent(diskUsage) : "快照待获取"}</strong></span><HardDrives size={26} weight="duotone" /></div>
            <div className="disk-meter"><i style={{ width: `${Number.isFinite(diskUsage) ? Math.min(100, diskUsage) : 0}%` }} /></div>
            <div className="disk-kpis">
              <span><small>总空间</small><strong>{diskTotal ? formatBytes(diskTotal) : "—"}</strong></span>
              <span><small>已使用</small><strong>{diskTotal ? formatBytes(diskUsed) : "—"}</strong></span>
              <span><small>剩余空间</small><strong>{diskTotal ? formatBytes(diskFree) : "—"}</strong></span>
              <span><small>使用率</small><strong>{formatPercent(diskUsage)}</strong></span>
            </div>
          </article>
        </section>}

        <section className="metric-grid">
          <article><span className="metric-icon"><HardDrives size={22} /></span><div><small>{source === "github" ? "GitHub 交付资产" : "逻辑资产规模"}</small><strong>{source === "github" ? `${dashboard?.assets?.length || 0} 项` : formatBytes(totalFootprint)}</strong><span>{source === "github" ? `${formatBytes(totalFootprint)} 制品与缓存` : `${dashboard?.assets?.length || 0} 项已识别资产`}</span></div></article>
          <article><span className="metric-icon safe"><Broom size={22} /></span><div><small>明确可安全清理</small><strong>{formatBytes(totalReclaimable)}</strong><span>按当前来源的安全策略计算</span></div></article>
          <article><span className="metric-icon warning"><ShieldCheck size={22} /></span><div><small>{source === "github" ? "Open / Draft PR" : "受保护资产"}</small><strong>{source === "github" ? openPullCount : protectedCount}</strong><span>{source === "github" ? "当前开发中的变更" : "数据库、上传与活动运行态"}</span></div></article>
          <article><span className="metric-icon blue"><ListDashes size={22} /></span><div><small>{source === "github" ? "Workflow Runs" : "事件账本"}</small><strong>{dashboard?.events?.length || 0}</strong><span>{source === "github" ? "最近加载的 CI 运行" : "当前加载的最近事件"}</span></div></article>
        </section>

        <section className="asset-overview card">
          <div className="section-heading"><div><span className="section-kicker">{source === "github" ? "DELIVERY MAP" : "CAPACITY MAP"}</span><h2>{source === "github" ? "GitHub 交付与存储状态" : "资产容量与清理状态"}</h2></div><div className="legend">{Object.entries(classifications).map(([key, value]) => <span key={key}><i style={{ background: value.color }} />{value.label}</span>)}</div></div>
          {source !== "local" && !dashboard?.remoteSnapshotAvailable ? <EmptyState source={selectedSource} error={dashboard?.remoteError} /> : <div className="bands">{dashboard?.bars?.map((bar) => <SegmentBar bar={bar} key={bar.type} selected={selectedType === bar.type} onSelect={setSelectedType} />)}</div>}
        </section>

        <section className="lower-grid">
          <article className="asset-table card">
            <div className="section-heading compact"><div><span className="section-kicker">ASSET DETAIL</span><h2>{barMeta[selectedType]?.label || "资产明细"}</h2></div><label className="search"><MagnifyingGlass size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资产或项目" /></label></div>
            <div className="table-head"><span>资产</span><span>项目 / 状态</span><span>分类</span><span>{metricHeading(selectedType)}</span></div>
            <div className="table-body">{visibleAssets.length === 0 ? <div className="table-empty">当前筛选没有资产</div> : visibleAssets.map((asset) => { const AssetIcon = barMeta[asset.type]?.Icon || Cube; return <div className="table-row" key={`${asset.type}-${asset.id}`}><span><AssetIcon size={17} weight="duotone" /><b>{asset.name}</b></span><span><b>{asset.project}</b><small>{asset.status}{asset.author ? ` · ${asset.author}` : ""}</small></span><span><i className={`classification classification-${asset.classification}`} />{classifications[asset.classification]?.label || asset.classification}</span><strong>{assetMetric(asset)}</strong></div>; })}</div>
          </article>
          <article className="ledger card">
            <div className="section-heading compact"><div><span className="section-kicker">EVENT LEDGER</span><h2>最近事件</h2></div><span className="ledger-count">{dashboard?.events?.length || 0}</span></div>
            <div className="event-list">{dashboard?.events?.slice(0, 8).map((event) => <div className="event-row" key={event.id}><span className="event-mark"><CheckCircle size={16} weight="fill" /></span><span><strong>{event.event}</strong><small>{event.project} · {event.environment}</small></span><time>{formatTime(event.occurredAt)}</time></div>)}{!dashboard?.events?.length && <div className="table-empty">暂无账本事件</div>}</div>
          </article>
        </section>

        <footer className="action-dock"><div><span className="dock-icon"><WarningCircle size={21} weight="duotone" /></span><span><strong>安全清理始终绑定当前预览</strong><small>{source === "github" ? "只删除失效缓存和过期制品。" : source === "local" ? "分析镜像引用和卷挂载；未知卷不会自动删除。" : "EC2 精确复核镜像引用和卷挂载，不碰容器、业务卷和 release。"}</small></span></div><div className="dock-actions"><button className="button secondary" type="button" disabled={source !== "local"} onClick={() => setScheduleOpen(true)}><ClockCountdown size={19} />定时清理</button><button className="button primary" type="button" disabled={!snapshotOnline || loading} onClick={requestPreview}><Broom size={19} />立即清理</button></div></footer>
      </main>
      {notice && <button className="toast" type="button" onClick={() => setNotice("")}><CheckCircle size={18} />{notice}<X size={15} /></button>}
      <CleanupModal preview={preview} loading={loading} onClose={() => setPreview(null)} onConfirm={confirmCleanup} />
      {scheduleOpen && <ScheduleModal schedule={dashboard?.schedule || { enabled: false, cadence: "weekly", day: "sunday", time: "03:00" }} onClose={() => setScheduleOpen(false)} onSave={saveSchedule} />}
    </div>
  );
}
