#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Root,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$ToolingRoot,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Owned
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Windows CI owner requires Windows' }
$Root = [IO.Path]::GetFullPath($Root)
$ToolingRoot = [IO.Path]::GetFullPath($ToolingRoot)
$Owned = [IO.Path]::GetFullPath($Owned)
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'KiaroSama/OmniRoute' -or
    $env:IMAGE_VALIDATION_LANE -ne 'compile-windows') { throw 'Owner-fork Windows lane only' }
if (-not $ToolingRoot.StartsWith("$Root$([IO.Path]::DirectorySeparatorChar)")) { throw 'Tooling escaped checkout' }
if (-not $Owned.StartsWith([IO.Path]::Combine($Root, '.ci-work') + [IO.Path]::DirectorySeparatorChar)) {
    throw 'Windows state escaped its owning project'
}
$evidence = Join-Path $Owned 'evidence'
if (-not (Test-Path -LiteralPath $evidence -PathType Container)) { throw 'Prepare isolated evidence first' }
Add-Type -Path (Join-Path $ToolingRoot 'image-windows-job.cs')
$jobName = 'Local\image-ci-' + [Guid]::NewGuid().ToString('N')
$job = $null
$child = $null
$childStarted = $false
$assigned = $false
$failure = $null
$terminated = @()
$remaining = @()
$started = [DateTime]::UtcNow
$lastProgress = $started
$bytes = 0L
$log = $null
$logStream = $null
try {
    $logStream = [IO.File]::Open((Join-Path $evidence 'windows-owner.log'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $log = [IO.StreamWriter]::new($logStream, [Text.UTF8Encoding]::new($false))
    $job = [ImageWindowsJob]::new($jobName, $true)
    $child = [Diagnostics.Process]::new()
    $child.StartInfo.FileName = (Get-Command node -CommandType Application).Source
    $child.StartInfo.WorkingDirectory = $Root
    $child.StartInfo.UseShellExecute = $false
    $child.StartInfo.CreateNoWindow = $true
    $child.StartInfo.RedirectStandardInput = $true
    $child.StartInfo.RedirectStandardOutput = $true
    $child.StartInfo.RedirectStandardError = $true
    $child.StartInfo.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $child.StartInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $child.StartInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $child.StartInfo.Environment.Clear()
    foreach ($key in @('PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'GITHUB_ACTIONS',
        'GITHUB_REPOSITORY', 'CANDIDATE_SHA', 'VALIDATION_WORKFLOW_SHA', 'IMAGE_VALIDATION_LANE')) {
        $value = [Environment]::GetEnvironmentVariable($key)
        if ($null -ne $value) { $child.StartInfo.Environment[$key] = $value }
    }
    $homePath = Join-Path $Owned 'isolated-home'
    foreach ($key in @('HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA')) {
        $child.StartInfo.Environment[$key] = $homePath
    }
    foreach ($key in @('TMPDIR', 'TMP', 'TEMP')) {
        $child.StartInfo.Environment[$key] = Join-Path $Owned 'tmp'
    }
    $child.StartInfo.Environment['IMAGE_VALIDATION_ROOT'] = $Owned
    $child.StartInfo.Environment['OWNED_ROOT'] = $Owned
    $child.StartInfo.Environment['IMAGE_WINDOWS_JOB_NAME'] = $jobName
    $child.StartInfo.Environment['IMAGE_WINDOWS_JOB_SOURCE'] = Join-Path $ToolingRoot 'image-windows-job.cs'
    $child.StartInfo.ArgumentList.Add((Join-Path $ToolingRoot 'image-windows-gate.mjs'))
    $child.StartInfo.ArgumentList.Add($Root)
    if (-not $child.Start()) { throw 'Could not start the waiting Windows gate' }
    $childStarted = $true
    $job.Assign($child.Handle)
    $assigned = $true
    $childStart = $child.StartTime.ToUniversalTime().ToFileTimeUtc()
    $wrongStart = [long]($childStart + 1L)
    if ($job.Inspect($child.Id, $childStart).Membership -ne 'owned' -or
        $job.Inspect($child.Id, $wrongStart).Membership -ne 'unknown' -or
        $job.TerminateOwned($child.Id, $wrongStart)) {
        throw 'Native creation-identity guard failed before admission'
    }
    $self = [Diagnostics.Process]::GetCurrentProcess()
    try {
        if ($job.Inspect($PID, $self.StartTime.ToUniversalTime().ToFileTimeUtc()).Membership -ne 'outside') {
            throw 'Native owner must remain outside its child job'
        }
    } finally { $self.Dispose() }
    $child.StandardInput.WriteLine('GO')
    $child.StandardInput.Close()
    $stdout = $child.StandardOutput.ReadLineAsync()
    $stderr = $child.StandardError.ReadLineAsync()
    $log.WriteLine("[$($started.ToString('o'))] [INFO] [windows-owner] Assigned waiting gate before execution")
    $log.Flush()
    $lastSize = 0L
    $exitedAt = $null
    while ($null -ne $stdout -or $null -ne $stderr -or -not $child.HasExited) {
        foreach ($stream in @('stdout', 'stderr')) {
            $pending = Get-Variable -Name $stream -ValueOnly
            if ($null -eq $pending -or -not $pending.IsCompleted) { continue }
            $line = $pending.GetAwaiter().GetResult()
            if ($null -eq $line) { Set-Variable -Name $stream -Value $null; continue }
            $bytes += [Text.Encoding]::UTF8.GetByteCount($line)
            if ($bytes -gt 16777216) { throw 'Windows owner output limit exceeded' }
            $lastProgress = [DateTime]::UtcNow
            $log.WriteLine($line)
            $log.Flush()
            [Console]::Out.WriteLine($line)
            $reader = if ($stream -eq 'stdout') { $child.StandardOutput } else { $child.StandardError }
            Set-Variable -Name $stream -Value $reader.ReadLineAsync()
        }
        $now = [DateTime]::UtcNow
        $size = 0L
        foreach ($file in Get-ChildItem -LiteralPath $evidence -Filter '*.log' -File) { $size += $file.Length }
        if ($size -ne $lastSize) { $lastSize = $size; $lastProgress = $now }
        if (($now - $started).TotalSeconds -gt 2220) { throw 'Windows owner wall timeout' }
        if (($now - $lastProgress).TotalSeconds -gt 600) { throw 'Windows owner idle timeout' }
        if ($child.HasExited) {
            if ($null -eq $exitedAt) { $exitedAt = $now }
            if (($now - $exitedAt).TotalSeconds -gt 3) { throw 'Owned output handles survived gate exit' }
        }
        [Threading.Tasks.Task]::Delay(100).GetAwaiter().GetResult()
    }
    if ($child.ExitCode -ne 0) { throw "Windows gate failed with exit code $($child.ExitCode)" }
    if ($job.Active() -ne 0) { throw 'Owned descendants survived the Windows gate' }
} catch {
    $failure = $_.Exception.Message
    [Console]::Error.WriteLine($failure)
} finally {
    try {
        if ($null -ne $job) { $terminated = @($job.Members()) }
        if ($terminated.Count -gt 0) {
            if ($null -eq $failure) { $failure = 'Owned descendants required forced cleanup' }
            $job.Terminate()
            $deadline = [DateTime]::UtcNow.AddSeconds(3)
            while ($job.Active() -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
                [Threading.Tasks.Task]::Delay(25).GetAwaiter().GetResult()
            }
        }
        if ($null -ne $job) { $remaining = @($job.Members()) }
        if ($remaining.Count -gt 0) { $failure = 'Windows job cleanup unverified' }
        if (-not $assigned -and $childStarted -and -not $child.HasExited) {
            # This handle belongs to the waiting gate; it has never received GO.
            $child.Kill()
            if (-not $child.WaitForExit(3000)) { $failure = 'Waiting gate cleanup failed' }
        }
    } catch { $failure = 'Windows ownership or cleanup inspection failed' }
    try {
        if ($null -ne $log) {
            $log.WriteLine("[$([DateTime]::UtcNow.ToString('o'))] [INFO] [windows-owner] completed assigned=$assigned remaining=$($remaining.Count)")
        }
        $receipt = @{
            candidate = $env:CANDIDATE_SHA; workflow = $env:VALIDATION_WORKFLOW_SHA
            startedAt = $started.ToString('o'); completedAt = [DateTime]::UtcNow.ToString('o')
            assigned = $assigned; clean = ($assigned -and $null -eq $failure -and $remaining.Count -eq 0)
            terminated = $terminated; remaining = $remaining; failure = $failure
        }
        [IO.File]::WriteAllText((Join-Path $evidence 'windows-job-cleanup.json'),
            ($receipt | ConvertTo-Json -Depth 5 -Compress), [Text.UTF8Encoding]::new($false))
    } finally {
        if ($null -ne $log) { $log.Dispose() }
        elseif ($null -ne $logStream) { $logStream.Dispose() }
        if ($null -ne $job) { $job.Dispose() }
        if ($null -ne $child) { $child.Dispose() }
    }
}
if ($null -ne $failure) { exit 1 }
exit 0
