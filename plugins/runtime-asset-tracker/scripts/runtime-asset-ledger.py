#!/usr/bin/env python3
"""Standard-library fallback for the Runtime Asset Tracker ledger."""

from __future__ import annotations

import argparse
import json
import os
import platform
import signal
import socket
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TRACKED_ATTRIBUTE_KEYS = {
    "name",
    "image",
    "container",
    "driver",
    "network",
    "scope",
    "type",
    "com.docker.compose.project",
    "com.docker.compose.service",
    "com.docker.compose.volume",
    "com.docker.compose.network",
    "org.opencontainers.image.revision",
}


def clean(value: Any, maximum: int = 4096) -> str | None:
    if value is None or value == "":
        return None
    return str(value).replace("\r", " ").replace("\n", " ").replace("\0", " ")[:maximum]


def compact(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: compact(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [compact(item) for item in value if item is not None]
    return value


def default_ledger_file() -> Path:
    configured = os.environ.get("RUNTIME_ASSET_LEDGER_FILE")
    if configured:
        return Path(configured).expanduser().resolve()
    if os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        return root / "RuntimeAssetTracker" / "events.jsonl"
    root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
    return root / "runtime-asset-tracker" / "events.jsonl"


def command_output(command: list[str], cwd: str | None = None) -> str:
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


def current_git_sha() -> str:
    return clean(
        os.environ.get("RUNTIME_ASSET_GIT_SHA")
        or os.environ.get("TARGET_COMMIT")
        or command_output(["git", "rev-parse", "HEAD"]),
        64,
    ) or "unknown"


def context(args: argparse.Namespace) -> dict[str, str]:
    return {
        "project": clean(args.project or os.environ.get("RUNTIME_ASSET_PROJECT"), 128) or "unknown",
        "environment": clean(args.environment or os.environ.get("RUNTIME_ASSET_ENVIRONMENT"), 64) or "unknown",
        "release": clean(args.release or os.environ.get("RUNTIME_ASSET_RELEASE"), 256) or "unknown",
        "gitSha": clean(args.git_sha or os.environ.get("RUNTIME_ASSET_GIT_SHA"), 64) or current_git_sha(),
        "owner": clean(args.owner or os.environ.get("RUNTIME_ASSET_OWNER"), 128) or "unknown",
    }


def details(entries: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for entry in entries:
        key, separator, value = entry.partition("=")
        safe_key = clean(key, 128)
        safe_value = clean(value)
        if separator and safe_key and safe_value is not None:
            result[safe_key] = safe_value
    return result


def append_event(args: argparse.Namespace, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    ledger_file = Path(args.ledger).expanduser().resolve() if args.ledger else default_ledger_file()
    ledger_file.parent.mkdir(parents=True, exist_ok=True)
    event: dict[str, Any] = {
        "schemaVersion": 1,
        "eventId": str(uuid.uuid4()),
        "occurredAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "event": clean(args.event, 128) or "runtime.unknown",
        "host": socket.gethostname(),
        **context(args),
        **(payload or {}),
    }
    event_details = details(args.detail)
    if event_details:
        event["details"] = event_details
    event = compact(event)
    with ledger_file.open("a", encoding="utf-8") as handle:
        if os.name != "nt":
            os.chmod(ledger_file, 0o600)
        handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    return {"ledgerFile": str(ledger_file), "event": event}


def safe_labels(labels: dict[str, Any] | None) -> dict[str, str]:
    result: dict[str, str] = {}
    for key, value in (labels or {}).items():
        if key.startswith("com.codex.runtime.") or key in {
            "org.opencontainers.image.revision",
            "org.opencontainers.image.source",
        }:
            safe_value = clean(value, 1024)
            if safe_value is not None:
                result[key] = safe_value
    return result


def docker_json(arguments: list[str]) -> Any:
    output = command_output(["docker", *arguments])
    if not output:
        raise RuntimeError(f"Docker command failed: docker {' '.join(arguments)}")
    return json.loads(output)


def json_lines(arguments: list[str]) -> list[dict[str, Any]]:
    output = command_output(["docker", *arguments])
    result: list[dict[str, Any]] = []
    for line in output.splitlines():
        try:
            item = json.loads(line)
            if isinstance(item, dict):
                result.append(item)
        except json.JSONDecodeError:
            continue
    return result


def record_image(args: argparse.Namespace) -> None:
    if not args.image:
        raise ValueError("image command requires --image")
    inspected = docker_json(["image", "inspect", args.image])
    image = inspected[0]
    append_event(args, {
        "asset": {
            "type": "image",
            "id": clean(image.get("Id"), 256),
            "reference": clean(args.image, 512),
            "repoTags": [clean(value, 512) for value in image.get("RepoTags") or []],
            "repoDigests": [clean(value, 512) for value in image.get("RepoDigests") or []],
            "createdAt": clean(image.get("Created"), 128),
            "sizeBytes": image.get("Size") if isinstance(image.get("Size"), (int, float)) else None,
            "labels": safe_labels((image.get("Config") or {}).get("Labels")),
            "service": clean(args.service, 128),
        }
    })


def snapshot(args: argparse.Namespace) -> None:
    containers = [
        {"id": item.get("ID"), "name": item.get("Names"), "image": item.get("Image"), "state": item.get("State"), "status": item.get("Status")}
        for item in json_lines(["ps", "-a", "--format", "{{json .}}"])
    ]
    images = [
        {"id": item.get("ID"), "repository": item.get("Repository"), "tag": item.get("Tag"), "createdAt": item.get("CreatedAt"), "size": item.get("Size")}
        for item in json_lines(["image", "ls", "--no-trunc", "--format", "{{json .}}"])
    ]
    volumes = [
        {"name": item.get("Name"), "driver": item.get("Driver"), "scope": item.get("Scope")}
        for item in json_lines(["volume", "ls", "--format", "{{json .}}"])
    ]
    networks = [
        {"id": item.get("ID"), "name": item.get("Name"), "driver": item.get("Driver"), "scope": item.get("Scope")}
        for item in json_lines(["network", "ls", "--no-trunc", "--format", "{{json .}}"])
    ]
    original_event = args.event
    args.event = args.event or "inventory.snapshot"
    append_event(args, {"inventory": {"containers": containers, "images": images, "volumes": volumes, "networks": networks}})
    args.event = original_event


def filtered_attributes(attributes: dict[str, Any] | None) -> dict[str, str]:
    result: dict[str, str] = {}
    for key, value in (attributes or {}).items():
        if key in TRACKED_ATTRIBUTE_KEYS or key.startswith("com.codex.runtime."):
            safe_value = clean(value, 1024)
            if safe_value is not None:
                result[key] = safe_value
    return result


def watch(args: argparse.Namespace) -> None:
    if platform.system() == "Windows":
        raise RuntimeError("Python watch fallback requires Linux; use the Node.js watcher on Windows")
    import fcntl

    ledger_file = Path(args.ledger).expanduser().resolve() if args.ledger else default_ledger_file()
    ledger_file.parent.mkdir(parents=True, exist_ok=True)
    lock_path = Path(f"{ledger_file}.watch.lock")
    lock_handle = lock_path.open("a+", encoding="utf-8")
    try:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock_handle.close()
        return
    lock_handle.seek(0)
    lock_handle.truncate()
    lock_handle.write(f"{os.getpid()}\n")
    lock_handle.flush()

    stopping = False
    child: subprocess.Popen[str] | None = None

    def stop(_signum: int, _frame: Any) -> None:
        nonlocal stopping, child
        stopping = True
        if child and child.poll() is None:
            child.terminate()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    args.ledger = str(ledger_file)
    original_event = args.event
    args.event = "observer.started"
    append_event(args, {"observerPid": os.getpid()})
    try:
        args.event = "inventory.bootstrap"
        snapshot(args)
    except Exception as error:  # Docker may be temporarily unavailable during boot.
        args.event = "inventory.bootstrap.failed"
        args.detail = [*args.detail, f"error={error}"]
        append_event(args)
    try:
        while not stopping:
            child = subprocess.Popen(
                ["docker", "events", "--format", "{{json .}}"],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
            assert child.stdout is not None
            for line in child.stdout:
                if stopping:
                    break
                try:
                    raw = json.loads(line)
                    asset_type = clean(raw.get("Type") or raw.get("type"), 64) or "unknown"
                    raw_action = str(raw.get("Action") or raw.get("action") or raw.get("status") or "unknown")
                    action = clean(raw_action.split(":", 1)[0].strip(), 64) or "unknown"
                    actor = raw.get("Actor") or {}
                    attributes = filtered_attributes(actor.get("Attributes"))
                    fallback = context(args)
                    args.event = f"docker.{asset_type}.{action}"
                    append_event(args, {
                        "project": clean(attributes.get("com.codex.runtime.project") or attributes.get("com.docker.compose.project"), 128) or fallback["project"],
                        "environment": clean(attributes.get("com.codex.runtime.environment"), 64) or fallback["environment"],
                        "release": clean(attributes.get("com.codex.runtime.release"), 256) or fallback["release"],
                        "gitSha": clean(attributes.get("com.codex.runtime.git-sha") or attributes.get("org.opencontainers.image.revision"), 64) or fallback["gitSha"],
                        "owner": clean(attributes.get("com.codex.runtime.owner"), 128) or fallback["owner"],
                        "asset": {"type": asset_type, "id": clean(actor.get("ID") or raw.get("id"), 256), "attributes": attributes},
                        "dockerTimeNano": clean(raw.get("timeNano"), 64),
                    })
                except (json.JSONDecodeError, TypeError, ValueError):
                    continue
            if not stopping:
                time.sleep(3)
    finally:
        args.event = "observer.stopped"
        append_event(args, {"observerPid": os.getpid()})
        args.event = original_event
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
        lock_handle.close()
        lock_path.unlink(missing_ok=True)


def parser() -> argparse.ArgumentParser:
    command_parser = argparse.ArgumentParser(prog="runtime-asset-ledger.py")
    command_parser.add_argument("command", choices=("record", "image", "snapshot", "watch"))
    command_parser.add_argument("--event")
    command_parser.add_argument("--ledger")
    command_parser.add_argument("--project")
    command_parser.add_argument("--environment")
    command_parser.add_argument("--release")
    command_parser.add_argument("--git-sha", dest="git_sha")
    command_parser.add_argument("--owner")
    command_parser.add_argument("--detail", action="append", default=[])
    command_parser.add_argument("--asset-type")
    command_parser.add_argument("--asset-id")
    command_parser.add_argument("--service")
    command_parser.add_argument("--status")
    command_parser.add_argument("--image")
    return command_parser


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "record":
            asset = None
            if args.asset_type or args.asset_id:
                asset = {"type": clean(args.asset_type, 64), "id": clean(args.asset_id, 256), "service": clean(args.service, 128)}
            append_event(args, {"asset": asset, "status": clean(args.status, 64)})
        elif args.command == "image":
            record_image(args)
        elif args.command == "snapshot":
            snapshot(args)
        else:
            watch(args)
        return 0
    except Exception as error:
        print(f"runtime-asset-ledger: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
