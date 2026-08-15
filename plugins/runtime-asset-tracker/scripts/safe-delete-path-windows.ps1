Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class RuntimeAssetWindowsSafeDelete
{
    private const uint DELETE = 0x00010000;
    private const uint FILE_LIST_DIRECTORY = 0x00000001;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint OBJ_CASE_INSENSITIVE = 0x00000040;
    private const uint FILE_OPEN = 0x00000001;
    private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
    private const uint FILE_OPEN_FOR_BACKUP_INTENT = 0x00004000;
    private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
    private const int FileIdBothDirectoryInformation = 37;
    private const int FileDispositionInfoEx = 21;
    private const uint FILE_DISPOSITION_FLAG_DELETE = 0x00000001;
    private const uint FILE_DISPOSITION_FLAG_POSIX_SEMANTICS = 0x00000002;
    private const uint FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE = 0x00000010;
    private const int STATUS_NO_MORE_FILES = unchecked((int)0x80000006);
    private const int STATUS_NO_SUCH_FILE = unchecked((int)0xC000000F);
    private const int STATUS_OBJECT_NAME_NOT_FOUND = unchecked((int)0xC0000034);

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint LowDateTime;
        public uint HighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UNICODE_STRING
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct OBJECT_ATTRIBUTES
    {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_STATUS_BLOCK
    {
        public IntPtr Status;
        public IntPtr Information;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out BY_HANDLE_FILE_INFORMATION information);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle file,
        int informationClass,
        IntPtr information,
        uint bufferSize);

    [DllImport("ntdll.dll")]
    private static extern int NtCreateFile(
        out SafeFileHandle fileHandle,
        uint desiredAccess,
        ref OBJECT_ATTRIBUTES objectAttributes,
        out IO_STATUS_BLOCK ioStatusBlock,
        IntPtr allocationSize,
        uint fileAttributes,
        uint shareAccess,
        uint createDisposition,
        uint createOptions,
        IntPtr eaBuffer,
        uint eaLength);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryDirectoryFile(
        SafeFileHandle fileHandle,
        IntPtr eventHandle,
        IntPtr apcRoutine,
        IntPtr apcContext,
        out IO_STATUS_BLOCK ioStatusBlock,
        IntPtr fileInformation,
        uint length,
        int fileInformationClass,
        [MarshalAs(UnmanagedType.U1)] bool returnSingleEntry,
        IntPtr fileName,
        [MarshalAs(UnmanagedType.U1)] bool restartScan);

    [DllImport("ntdll.dll")]
    private static extern uint RtlNtStatusToDosError(int status);

    private sealed class Identity
    {
        public uint Volume;
        public ulong FileId;
        public uint Attributes;
    }

    private sealed class DirectoryEntry
    {
        public string Name;
        public ulong FileId;
    }

    public static void Delete(
        string rootPath,
        string relativeTarget,
        string expectedRootDevice,
        string expectedRootFileId,
        string expectedTargetDevice,
        string expectedTargetFileId)
    {
        if (String.IsNullOrWhiteSpace(rootPath)) throw new InvalidOperationException("Managed root is required.");
        string[] components = ParseRelativePath(relativeTarget);
        using (SafeFileHandle root = OpenRoot(rootPath))
        {
            Identity rootIdentity = ReadIdentity(root);
            RequireIdentity("managed root", rootIdentity, expectedRootDevice, expectedRootFileId);
            if ((rootIdentity.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                throw new InvalidOperationException("Managed root is a reparse point.");

            SafeFileHandle current = root;
            var opened = new List<SafeFileHandle>();
            try
            {
                for (int index = 0; index < components.Length; index++)
                {
                    SafeFileHandle next = OpenRelative(current, components[index]);
                    opened.Add(next);
                    Identity identity = ReadIdentity(next);
                    bool target = index == components.Length - 1;
                    if (!target && (identity.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                        throw new InvalidOperationException("Target ancestry contains a reparse point.");
                    if (!target && (identity.Attributes & FILE_ATTRIBUTE_DIRECTORY) == 0)
                        throw new InvalidOperationException("Target ancestry contains a non-directory component.");
                    if (target) RequireIdentity("target", identity, expectedTargetDevice, expectedTargetFileId);
                    current = next;
                }

                DeleteOpenedTree(current);
            }
            finally
            {
                for (int index = opened.Count - 1; index >= 0; index--) opened[index].Dispose();
            }
        }
    }

    private static string[] ParseRelativePath(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || Path.IsPathRooted(value))
            throw new InvalidOperationException("Target must be a non-empty path relative to the managed root.");
        string[] components = value.Split(new[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);
        if (components.Length == 0) throw new InvalidOperationException("Managed root itself cannot be deleted.");
        foreach (string component in components)
        {
            if (component == "." || component == ".." || component.IndexOf(':') >= 0 || component.IndexOf('\0') >= 0)
                throw new InvalidOperationException("Target contains an unsafe path component.");
        }
        return components;
    }

    private static SafeFileHandle OpenRoot(string path)
    {
        SafeFileHandle handle = CreateFileW(
            ToExtendedPath(path),
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_DELETE,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error, "Unable to open the managed root without following reparse points.");
        }
        return handle;
    }

    private static SafeFileHandle OpenRelative(SafeFileHandle parent, string name)
    {
        IntPtr nameBuffer = IntPtr.Zero;
        IntPtr unicodePointer = IntPtr.Zero;
        try
        {
            nameBuffer = Marshal.StringToHGlobalUni(name);
            UNICODE_STRING unicode = new UNICODE_STRING
            {
                Length = checked((ushort)(name.Length * 2)),
                MaximumLength = checked((ushort)((name.Length + 1) * 2)),
                Buffer = nameBuffer
            };
            unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
            Marshal.StructureToPtr(unicode, unicodePointer, false);
            OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES
            {
                Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
                RootDirectory = parent.DangerousGetHandle(),
                ObjectName = unicodePointer,
                Attributes = OBJ_CASE_INSENSITIVE,
                SecurityDescriptor = IntPtr.Zero,
                SecurityQualityOfService = IntPtr.Zero
            };
            IO_STATUS_BLOCK ioStatus;
            SafeFileHandle child;
            int status = NtCreateFile(
                out child,
                DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                ref attributes,
                out ioStatus,
                IntPtr.Zero,
                0,
                FILE_SHARE_READ | FILE_SHARE_DELETE,
                FILE_OPEN,
                FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT | FILE_OPEN_REPARSE_POINT,
                IntPtr.Zero,
                0);
            if (status < 0)
            {
                if (child != null) child.Dispose();
                ThrowNt(status, "Unable to open a target component relative to its verified parent handle.");
            }
            return child;
        }
        finally
        {
            if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
            if (nameBuffer != IntPtr.Zero) Marshal.FreeHGlobal(nameBuffer);
        }
    }

    private static Identity ReadIdentity(SafeFileHandle handle)
    {
        BY_HANDLE_FILE_INFORMATION information;
        if (!GetFileInformationByHandle(handle, out information))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to read file identity from a verified handle.");
        return new Identity
        {
            Volume = information.VolumeSerialNumber,
            FileId = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow,
            Attributes = information.FileAttributes
        };
    }

    private static void RequireIdentity(string label, Identity actual, string device, string fileId)
    {
        uint expectedDevice;
        ulong expectedFileId;
        if (!UInt32.TryParse(device, out expectedDevice) || !UInt64.TryParse(fileId, out expectedFileId))
            throw new InvalidOperationException("Expected " + label + " identity is invalid.");
        if (actual.Volume != expectedDevice || actual.FileId != expectedFileId)
            throw new InvalidOperationException("The " + label + " identity changed after preview validation.");
    }

    private static void DeleteOpenedTree(SafeFileHandle handle)
    {
        Identity identity = ReadIdentity(handle);
        bool directory = (identity.Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        bool reparse = (identity.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
        if (directory && !reparse)
        {
            foreach (DirectoryEntry entry in ReadChildEntries(handle))
            {
                using (SafeFileHandle child = OpenRelative(handle, entry.Name))
                {
                    Identity childIdentity = ReadIdentity(child);
                    if (childIdentity.Volume != identity.Volume || childIdentity.FileId != entry.FileId)
                        throw new InvalidOperationException("A directory child identity changed between handle enumeration and relative open.");
                    DeleteOpenedTree(child);
                }
            }
        }
        MarkDeleteOnClose(handle);
    }

    private static List<DirectoryEntry> ReadChildEntries(SafeFileHandle directory)
    {
        const int bufferSize = 64 * 1024;
        var entries = new List<DirectoryEntry>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
        try
        {
            bool restart = true;
            while (true)
            {
                IO_STATUS_BLOCK ioStatus;
                int status = NtQueryDirectoryFile(
                    directory,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    out ioStatus,
                    buffer,
                    bufferSize,
                    FileIdBothDirectoryInformation,
                    false,
                    IntPtr.Zero,
                    restart);
                restart = false;
                if (status == STATUS_NO_MORE_FILES) break;
                if (status < 0) ThrowNt(status, "Unable to enumerate a verified directory handle.");
                int offset = 0;
                while (true)
                {
                    uint nextOffset = unchecked((uint)Marshal.ReadInt32(buffer, offset));
                    uint nameBytes = unchecked((uint)Marshal.ReadInt32(buffer, offset + 60));
                    if ((nameBytes & 1) != 0 || nameBytes > bufferSize - offset - 104)
                        throw new InvalidOperationException("Windows returned an invalid directory entry.");
                    ulong fileId = unchecked((ulong)Marshal.ReadInt64(buffer, offset + 96));
                    string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 104), checked((int)nameBytes / 2));
                    if (name != "." && name != ".." && !String.IsNullOrEmpty(name))
                    {
                        if (name.IndexOf('\\') >= 0 || name.IndexOf('/') >= 0 || name.IndexOf('\0') >= 0)
                            throw new InvalidOperationException("Windows returned an unsafe directory entry name.");
                        if (seen.Add(name)) entries.Add(new DirectoryEntry { Name = name, FileId = fileId });
                    }
                    if (nextOffset == 0) break;
                    if (nextOffset > bufferSize - offset) throw new InvalidOperationException("Windows returned an invalid directory entry offset.");
                    offset += checked((int)nextOffset);
                }
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return entries;
    }

    private static void MarkDeleteOnClose(SafeFileHandle handle)
    {
        IntPtr flags = Marshal.AllocHGlobal(sizeof(uint));
        try
        {
            Marshal.WriteInt32(flags, unchecked((int)(
                FILE_DISPOSITION_FLAG_DELETE |
                FILE_DISPOSITION_FLAG_POSIX_SEMANTICS |
                FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE)));
            if (!SetFileInformationByHandle(handle, FileDispositionInfoEx, flags, sizeof(uint)))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to mark an exact verified handle for deletion.");
        }
        finally
        {
            Marshal.FreeHGlobal(flags);
        }
    }

    private static string ToExtendedPath(string path)
    {
        string full = Path.GetFullPath(path);
        if (full.StartsWith(@"\\?\", StringComparison.Ordinal)) return full;
        if (full.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + full.Substring(2);
        return @"\\?\" + full;
    }

    private static void ThrowNt(int status, string message)
    {
        if (status == STATUS_NO_SUCH_FILE || status == STATUS_OBJECT_NAME_NOT_FOUND)
            throw new FileNotFoundException(message);
        throw new Win32Exception(unchecked((int)RtlNtStatusToDosError(status)), message);
    }
}
'@

try {
    Add-Type -TypeDefinition $source -Language CSharp
    [RuntimeAssetWindowsSafeDelete]::Delete(
        $env:RAT_SAFE_DELETE_ROOT,
        $env:RAT_SAFE_DELETE_RELATIVE,
        $env:RAT_SAFE_DELETE_ROOT_DEV,
        $env:RAT_SAFE_DELETE_ROOT_INO,
        $env:RAT_SAFE_DELETE_TARGET_DEV,
        $env:RAT_SAFE_DELETE_TARGET_INO)
    exit 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
