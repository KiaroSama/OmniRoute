import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { ownedDescendants } from "./image-validation-contract.mjs";

export function processSnapshot() {
  if (process.platform === "win32") {
    const source =
      "$sensor=$PID; $rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n='Start';e={$_.CreationDate.ToUniversalTime().ToString('o')}}); @{sensor=$sensor;rows=$rows} | ConvertTo-Json -Compress";
    const items = JSON.parse(
      execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", source], {
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })
    );
    return new Map(
      items.rows
        .filter((item) => item.ProcessId !== items.sensor)
        .map((item) => [
          String(item.ProcessId),
          {
            start: item.Start,
            parent: String(item.ParentProcessId),
            state: "R",
          },
        ])
    );
  }
  const entries = new Map();
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
      entries.set(pid, { start: fields[19], parent: fields[1], state: fields[0] });
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
    }
  }
  return entries;
}

export function prepareImageState(root, owned) {
  const relative = path.relative(path.join(root, ".ci-work"), owned);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "CI state must be project-contained"
  );
  fs.mkdirSync(path.dirname(owned), { recursive: true });
  fs.mkdirSync(owned, { recursive: false, mode: 0o700 });
  for (const name of ["isolated-home", "isolated-data", "isolated-plugins", "tmp", "evidence"]) {
    fs.mkdirSync(path.join(owned, name), { mode: 0o700 });
  }
  fs.writeFileSync(
    path.join(owned, "process-baseline.json"),
    JSON.stringify([...processSnapshot()]),
    "utf8"
  );
}

export function imageEnvironment(root, owned, extra = {}) {
  const env = Object.fromEntries(
    ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]])
  );
  return {
    ...env,
    PATH: `${path.join(root, "node_modules/.bin")}${path.delimiter}${process.env.PATH}`,
    LANG: "C.UTF-8",
    CI: "true",
    GITHUB_ACTIONS: "true",
    NODE_ENV: "test",
    OWNED_ROOT: owned,
    HOME: path.join(owned, "isolated-home"),
    USERPROFILE: path.join(owned, "isolated-home"),
    APPDATA: path.join(owned, "isolated-home"),
    LOCALAPPDATA: path.join(owned, "isolated-home"),
    XDG_CONFIG_HOME: path.join(owned, "isolated-home"),
    XDG_CACHE_HOME: path.join(owned, "isolated-home"),
    TMPDIR: path.join(owned, "tmp"),
    TMP: path.join(owned, "tmp"),
    TEMP: path.join(owned, "tmp"),
    DATA_DIR: path.join(owned, "isolated-data"),
    OMNIROUTE_PLUGINS_DIR: path.join(owned, "isolated-plugins"),
    npm_config_cache: path.join(owned, "npm-cache"),
    APP_LOG_TO_FILE: "false",
    DISABLE_SQLITE_AUTO_BACKUP: "true",
    OMNIROUTE_SKIP_SYSTEM_TRUST: "1",
    OMNIROUTE_SKIP_DNS_WRITE: "1",
    ADOBE_FIREFLY_BROWSER_REFRESH: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    OMNIROUTE_DISABLE_BACKGROUND_SERVICES: "true",
    OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK: "true",
    HOOKMAKER_MAX_TEST_WORKERS: "2",
    OMNIROUTE_MAX_TEST_WORKERS: "2",
    NODE_OPTIONS: "--max-old-space-size=3072",
    ...extra,
  };
}

export function offlineCommand(command, args, env) {
  assert.equal(
    process.platform,
    "linux",
    "Offline application checks require Linux network isolation"
  );
  const script =
    'uid="$1"; gid="$2"; shift 2; ip link set lo up; exec setpriv --reuid "$uid" --regid "$gid" --clear-groups -- "$@"';
  return [
    "sudo",
    [
      "-n",
      "unshare",
      "--net",
      "--pid",
      "--fork",
      "--kill-child",
      "--",
      "/bin/bash",
      "-euc",
      script,
      "image-ci",
      String(process.getuid()),
      String(process.getgid()),
      "/usr/bin/env",
      "-i",
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      command,
      ...args,
    ],
  ];
}

// Windows uses creation identities; the shared POSIX gate's taskkill path is not reused.
export async function runWindowsImageGate(command, args, options) {
  assert.equal(process.platform, "win32", "Windows process owner only");
  const { cwd, env, logPath, timeout, idle, signal } = options;
  assert.ok(!signal?.aborted, "Cancelled check cannot spawn a Windows child");
  const startedAt = new Date().toISOString();
  const baseline = processSnapshot();
  const owned = new Map([[String(process.pid), baseline.get(String(process.pid))]]);
  assert.ok(owned.get(String(process.pid))?.start, "Process owner identity unavailable");
  let output = "",
    lastOutput = Date.now(),
    failure,
    code,
    closed = false;
  const log = fs.openSync(logPath, "wx", 0o600);
  const child = spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = new Promise((resolve) => {
    child.once("error", (error) => {
      failure = error.code;
      resolve();
    });
    child.once("close", (value) => {
      closed = true;
      code = value;
      resolve();
    });
  });
  const capture = (chunk) => {
    lastOutput = Date.now();
    fs.writeSync(log, chunk);
    if (output.length < 16 * 1024 * 1024) output += chunk.toString("utf8");
    else failure = "OUTPUT_LIMIT";
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const started = Date.now();
  try {
    do {
      const snapshot = processSnapshot();
      for (const [pid, item] of ownedDescendants(snapshot, owned)) owned.set(pid, item);
      const journal = path.join(env.OWNED_ROOT, "process-owned.json");
      const previous = fs.existsSync(journal) ? JSON.parse(fs.readFileSync(journal, "utf8")) : [];
      fs.writeFileSync(journal, JSON.stringify([...new Map([...previous, ...owned])]), "utf8");
      if (signal?.aborted) failure ||= "CANCELLED";
      if (Date.now() - started > timeout) failure ||= "TIMEOUT";
      if (Date.now() - lastOutput > idle) failure ||= "IDLE_TIMEOUT";
      if (failure || closed) break;
      await Promise.race([exit, pause(1000)]);
    } while (!closed);
    for (const [pid, item] of owned) {
      if (pid === String(process.pid) || baseline.get(pid)?.start === item?.start) continue;
      const current = processSnapshot().get(pid);
      if (current?.start !== item.start) continue;
      failure ||= "ORPHANED_DESCENDANTS";
      execFileSync("taskkill", ["/PID", pid, "/F"], {
        windowsHide: true,
        timeout: 10000,
        stdio: "ignore",
      });
    }
    await Promise.race([exit, pause(3000)]);
    if (!closed) {
      failure ||= "CLEANUP_ERROR";
      child.stdout.destroy();
      child.stderr.destroy();
    }
    const remaining = processSnapshot();
    for (const [pid, item] of owned) {
      if (pid !== String(process.pid) && remaining.get(pid)?.start === item?.start)
        failure ||= "CLEANUP_ERROR";
    }
  } catch (error) {
    failure ||= "PROCESS_OWNER_ERROR";
    // Never accept a snapshot/cleanup exception as a successful child exit.
    console.error(error instanceof Error ? error.message : "Process owner failed");
    try {
      const current = processSnapshot();
      for (const [pid, item] of ownedDescendants(current, owned)) owned.set(pid, item);
      for (const [pid, item] of owned) {
        if (pid !== String(process.pid) && processSnapshot().get(pid)?.start === item?.start) {
          execFileSync("taskkill", ["/PID", pid, "/F"], {
            windowsHide: true,
            timeout: 10000,
            stdio: "ignore",
          });
        }
      }
    } catch {
      failure = "CLEANUP_ERROR";
    }
    child.stdout.destroy();
    child.stderr.destroy();
  } finally {
    child.stdout.off("data", capture);
    child.stderr.off("data", capture);
    fs.closeSync(log);
  }
  const receipt = {
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    outcome: failure || (code === 0 ? "PASS" : "FAIL"),
    exitCode: code,
    cleanupError: failure === "CLEANUP_ERROR" ? failure : null,
  };
  fs.writeFileSync(`${logPath}.json`, JSON.stringify(receipt) + "\n", "utf8");
  return { code: failure || code !== 0 ? 1 : 0, out: output, receipt };
}

export async function sweepImageProcesses(owned) {
  const baseline = new Map(
    JSON.parse(fs.readFileSync(path.join(owned, "process-baseline.json"), "utf8"))
  );
  const snapshot = processSnapshot();
  const protectedIds = new Set();
  let parent = String(process.pid);
  while (parent && !protectedIds.has(parent)) {
    protectedIds.add(parent);
    parent = snapshot.get(parent)?.parent;
  }
  const trackedPath = path.join(owned, "process-owned.json");
  const tracked = fs.existsSync(trackedPath)
    ? new Map(JSON.parse(fs.readFileSync(trackedPath, "utf8")))
    : new Map();
  const killed = [],
    unreadable = [];
  for (const [pid, item] of snapshot) {
    if (protectedIds.has(pid) || baseline.get(pid)?.start === item.start || item.state === "Z")
      continue;
    let marked;
    if (process.platform === "win32") {
      marked = tracked.get(pid)?.start === item.start;
      // A path-free command line cannot disprove ownership; never report it clean by omission.
      if (!marked && processSnapshot().get(pid)?.start === item.start)
        unreadable.push({ pid, start: item.start });
    } else {
      try {
        marked = fs
          .readFileSync(`/proc/${pid}/environ`)
          .includes(Buffer.from(`OWNED_ROOT=${owned}\0`));
      } catch (error) {
        if (["ENOENT", "ESRCH"].includes(error.code)) continue;
        if (error.code === "EACCES") {
          try {
            if (fs.statSync(`/proc/${pid}`).uid === process.getuid())
              unreadable.push({ pid, start: item.start });
          } catch (race) {
            if (!["ENOENT", "ESRCH"].includes(race.code)) throw race;
          }
          continue;
        }
        throw error;
      }
    }
    if (!marked || processSnapshot().get(pid)?.start !== item.start) continue;
    killed.push({ pid, start: item.start });
    if (process.platform === "win32")
      execFileSync("taskkill", ["/PID", pid, "/F"], {
        timeout: 10000,
        windowsHide: true,
        stdio: "ignore",
      });
    else {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  const deadline = Date.now() + 3000;
  let remaining = killed;
  do {
    const current = processSnapshot();
    remaining = remaining.filter(
      (item) => current.get(item.pid)?.start === item.start && current.get(item.pid)?.state !== "Z"
    );
    if (!remaining.length) break;
    await pause(25);
  } while (Date.now() < deadline);
  const receipt = {
    clean: !killed.length && !unreadable.length && !remaining.length,
    killed,
    unreadable,
    remaining,
  };
  fs.writeFileSync(
    path.join(owned, "evidence/cleanup.json"),
    JSON.stringify(receipt) + "\n",
    "utf8"
  );
  assert.equal(receipt.clean, true, "Owned cleanup or new-process ownership could not be verified");
  console.log("PASS: no owned subprocess survived");
}
