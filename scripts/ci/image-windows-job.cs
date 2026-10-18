using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

// A dedicated non-breakaway job owns only the explicitly assigned CI gate and its children.
public sealed class ImageWindowsJob : IDisposable {
    private IntPtr handle;

    [StructLayout(LayoutKind.Sequential)]
    private struct Limits {
        public long UserTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
        public Limits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint PageFaults, Total, Active, Terminated;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime { public uint Low, High; }

    public sealed class Identity {
        public long Start;
        public string Membership = "unknown";
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, uint size, IntPtr returned);
    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)]
    private static extern bool QueryRaw(IntPtr job, int kind, IntPtr data, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr value);

    public ImageWindowsJob(string name, bool create) {
        handle = create ? CreateJobObject(IntPtr.Zero, name) : OpenJobObject(4, false, name);
        int error = Marshal.GetLastWin32Error();
        if (handle == IntPtr.Zero) throw new Win32Exception(error);
        if (!create) return;
        try {
            if (error == 183) throw new InvalidOperationException("CI job identity already exists");
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; neither breakaway flag is enabled.
            if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        } catch { Dispose(); throw; }
    }

    public void Assign(IntPtr process) {
        if (!AssignProcessToJobObject(handle, process))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        bool member;
        if (!IsProcessInJob(process, handle, out member) || !member)
            throw new InvalidOperationException("CI gate membership could not be verified");
    }

    public Identity Inspect(int pid, long expectedStart) {
        Identity result = new Identity();
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return result;
        try {
            FileTime creation, exit, kernel, user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return result;
            result.Start = ((long)creation.High << 32) | creation.Low;
            if (result.Start != expectedStart) return result;
            bool member;
            if (IsProcessInJob(process, handle, out member)) result.Membership = member ? "owned" : "outside";
            return result;
        } finally { CloseHandle(process); }
    }

    public uint Active() {
        Accounting value;
        if (!QueryInformationJobObject(handle, 1, out value, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return value.Active;
    }

    public int[] Members() {
        const int capacity = 4096;
        int size = 8 + IntPtr.Size * capacity;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            if (!QueryRaw(handle, 3, buffer, (uint)size, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            int assigned = Marshal.ReadInt32(buffer, 0);
            int count = Marshal.ReadInt32(buffer, 4);
            if (assigned != count || count < 0 || count > capacity)
                throw new InvalidOperationException("Incomplete CI job membership inventory");
            int[] values = new int[count];
            for (int i = 0; i < count; i++) values[i] = checked((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
            return values;
        } finally { Marshal.FreeHGlobal(buffer); }
    }

    public bool TerminateOwned(int pid, long expectedStart) {
        IntPtr process = OpenProcess(0x1001, false, pid);
        if (process == IntPtr.Zero) return false;
        try {
            FileTime creation, exit, kernel, user;
            bool member;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user) ||
                (((long)creation.High << 32) | creation.Low) != expectedStart) return false;
            if (!IsProcessInJob(process, handle, out member) || !member) return false;
            if (!TerminateProcess(process, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return true;
        } finally { CloseHandle(process); }
    }

    public void Terminate() {
        if (!TerminateJobObject(handle, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public void Dispose() {
        if (handle == IntPtr.Zero) return;
        CloseHandle(handle);
        handle = IntPtr.Zero;
    }
}
