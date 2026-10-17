#!/usr/bin/env node
/**
 * measure-boundary.mjs — reproducible measurement of the src ⇄ open-sse coupling.
 *
 * Rail 3.8.55 (Task 13). v4 splits the engine (`open-sse/`) from the app modules
 * (`src/lib/*`). This script gives the LTS a repeatable number for that coupling
 * instead of hand-built tables:
 *
 *   - scans `src/**\/*.ts(x)` and `open-sse/**\/*.ts(x)` (skips node_modules, .next,
 *     tests/, __tests__/, *.test.*, *.spec.*);
 *   - extracts static imports/re-exports (`import … from`, `export … from`,
 *     `import "x"`), dynamic `import("x")` and `require("x")` — comments, string
 *     contents, template literals and regex literals are lexed out first so a
 *     specifier mentioned in a comment does not count;
 *   - resolves `@/…`, `@omniroute/open-sse[/…]` and relative specifiers to a
 *     repo-relative file (ts/tsx/js/mjs/json/index fallbacks; unresolved paths keep
 *     their normalized spelling);
 *   - counts cross-boundary edges as unique (importing file, imported file) pairs in
 *     both directions and aggregates them per subsystem of origin
 *     (`src/lib/<name>`, `src/app/api/<route>`, `src/<dir>`, `open-sse/<dir>`).
 *
 * `open-sse → src` should trend to zero: the engine must not depend on the app. The
 * full list of those edges is emitted (`openSseToSrcEdges`) as the v4 remediation list.
 *
 * Ratchet: `open-sse → src` went 745 → 768 edges between 2026-10-10 and 2026-10-16 while
 * this script only measured it, so the count now has a frozen ceiling in
 * `config/quality/quality-baseline.json` → `metrics.boundaryOpenSseToSrc` (`direction:
 * down`, `dedicatedGate: true`, same shape as `metrics.cycles`):
 *   - `--ratchet` blocks (exit 1) when `edges.openSseToSrc` exceeds that ceiling; with no
 *     ceiling in the baseline it is advisory (exit 0 + warning);
 *   - `--update` writes the measured count as the new ceiling, but only when it is not
 *     higher than the current one — the ceiling only goes down. Raising it is a manual,
 *     justified edit of the baseline, never a way to make the gate green.
 * Without either flag the Markdown/JSON report is unchanged.
 *
 * Usage:
 *   node scripts/quality/measure-boundary.mjs --json [--root <dir>]
 *   node scripts/quality/measure-boundary.mjs --md   [--root <dir>]
 *   node scripts/quality/measure-boundary.mjs --ratchet [--root <dir>] [--baseline <file>]
 *   node scripts/quality/measure-boundary.mjs --update  [--root <dir>] [--baseline <file>]
 *
 * Only `node:fs` / `node:path` / `node:url`; no child processes, no shell.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXT_RE = /\.(?:ts|tsx)$/;
const TEST_FILE_RE = /\.(?:test|spec)\.(?:ts|tsx)$/;
const SKIPPED_DIRS = new Set(["node_modules", ".next", "tests", "__tests__"]);
const SCANNED_ROOTS = ["src", "open-sse"];
const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];
const TOP_TARGETS = 5;
const STR = "\u0001";

// Characters / keywords after which a `/` starts a regex literal instead of a division.
const REGEX_PREFIX_CHARS = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_PREFIX_WORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "void",
  "yield",
  "await",
  "delete",
  "throw",
  "instanceof",
  "new",
]);

/**
 * Lex `source` into code with comments removed and every quoted string literal replaced
 * by an indexed placeholder. Template literal text is dropped (its `${…}` code is kept).
 * Returns `{ code, strings }`.
 */
function maskSource(source) {
  const strings = [];
  let code = "";
  let i = 0;
  const n = source.length;
  // Each entry is the brace depth inside a template `${ … }` substitution.
  const templateStack = [];
  let lastToken = "";

  const readTemplate = () => {
    // Called with i positioned just after a "`" or a closing "}" of a substitution.
    while (i < n) {
      const c = source[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        code += " ";
        lastToken = "a";
        return;
      }
      if (c === "$" && source[i + 1] === "{") {
        i += 2;
        templateStack.push(0);
        code += " ";
        lastToken = "{";
        return;
      }
      i++;
    }
  };

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];

    if (c === "/" && d === "/") {
      while (i < n && source[i] !== "\n") i++;
      code += " ";
      continue;
    }
    if (c === "/" && d === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      code += " ";
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = "";
      while (j < n && source[j] !== c && source[j] !== "\n") {
        if (source[j] === "\\") {
          value += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        value += source[j];
        j++;
      }
      i = j + 1;
      code += `${STR}${strings.length}${STR}`;
      strings.push(value);
      lastToken = "a";
      continue;
    }
    if (c === "`") {
      i++;
      readTemplate();
      continue;
    }
    if (c === "{" && templateStack.length > 0) {
      templateStack[templateStack.length - 1]++;
    }
    if (c === "}" && templateStack.length > 0) {
      if (templateStack[templateStack.length - 1] === 0) {
        templateStack.pop();
        i++;
        readTemplate();
        continue;
      }
      templateStack[templateStack.length - 1]--;
    }
    if (c === "/") {
      const startsRegex =
        lastToken === "" || REGEX_PREFIX_CHARS.has(lastToken) || REGEX_PREFIX_WORDS.has(lastToken);
      if (startsRegex) {
        let j = i + 1;
        let inClass = false;
        while (j < n && source[j] !== "\n") {
          const r = source[j];
          if (r === "\\") {
            j += 2;
            continue;
          }
          if (r === "[") inClass = true;
          else if (r === "]") inClass = false;
          else if (r === "/" && !inClass) break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(source[j])) j++;
        i = j;
        code += " ";
        lastToken = "a";
        continue;
      }
    }

    code += c;
    if (/[\w$]/.test(c)) {
      // Track the whole word so keyword prefixes (return, typeof, …) are recognised.
      let j = i + 1;
      while (j < n && /[\w$]/.test(source[j])) j++;
      const word = source.slice(i, j);
      code += word.slice(1);
      lastToken = word;
      i = j;
      continue;
    }
    if (!/\s/.test(c)) lastToken = c;
    i++;
  }
  return { code, strings };
}

const S = `${STR}(\\d+)${STR}`;
const NOT_MEMBER = "(?:^|[^.\\w$])";
const IMPORT_PATTERNS = [
  // import x from "a" / import type { B } from "b" / import * as ns from "c"
  new RegExp(`${NOT_MEMBER}import\\s*[\\w$*{},\\s]+?\\s*from\\s*${S}`, "g"),
  // export * from "e" / export { f } from "f" / export type { G } from "g"
  new RegExp(
    `${NOT_MEMBER}export\\s*(?:type\\s+)?(?:\\*(?:\\s*as\\s+[\\w$]+)?|\\{[^}]*\\})\\s*from\\s*${S}`,
    "g"
  ),
  // import "side-effect"
  new RegExp(`${NOT_MEMBER}import\\s*${S}`, "g"),
  // import("dynamic")
  new RegExp(`${NOT_MEMBER}import\\s*\\(\\s*${S}\\s*[,)]`, "g"),
  // require("cjs")
  new RegExp(`${NOT_MEMBER}require\\s*\\(\\s*${S}\\s*\\)`, "g"),
];

/** Return the module specifiers imported by `source` (deduplicated, in first-seen order). */
export function extractImportSpecifiers(source) {
  const { code, strings } = maskSource(source);
  const seen = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of code.matchAll(pattern)) {
      seen.add(strings[Number(match[1])]);
    }
  }
  return [...seen];
}

function stripExt(name) {
  return name.replace(/\.(?:ts|tsx|js|mjs|cjs|json)$/, "");
}

/** Subsystem of a repo-relative path (posix separators). */
export function subsystemOf(relPath) {
  const parts = relPath.split("/");
  if (parts[0] === "open-sse") {
    return parts.length > 2 ? `open-sse/${parts[1]}` : "open-sse/(root)";
  }
  if (parts[0] === "src") {
    if (parts[1] === "lib" && parts.length > 2) {
      return `src/lib/${parts.length > 3 ? parts[2] : stripExt(parts[2])}`;
    }
    if (parts[1] === "app" && parts[2] === "api" && parts.length > 3) {
      return `src/app/api/${parts.length > 4 ? parts[3] : stripExt(parts[3])}`;
    }
    return parts.length > 2 ? `src/${parts[1]}` : "src/(root)";
  }
  return parts[0];
}

function listSourceFiles(root, top) {
  const out = [];
  const walk = (relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(rel);
      } else if (
        entry.isFile() &&
        SOURCE_EXT_RE.test(entry.name) &&
        !TEST_FILE_RE.test(entry.name)
      ) {
        out.push(rel);
      }
    }
  };
  walk(top);
  return out;
}

function createResolver(root) {
  const cache = new Map();
  const isFile = (rel) => {
    try {
      return fs.statSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  };
  return (target) => {
    if (cache.has(target)) return cache.get(target);
    let resolved = null;
    for (const suffix of RESOLVE_SUFFIXES) {
      if (isFile(`${target}${suffix}`)) {
        resolved = `${target}${suffix}`;
        break;
      }
    }
    // TS-style `./x.js` that points at `./x.ts`.
    if (!resolved && /\.(?:m?js)$/.test(target)) {
      const base = target.replace(/\.(?:m?js)$/, "");
      for (const ext of [".ts", ".tsx"]) {
        if (isFile(`${base}${ext}`)) {
          resolved = `${base}${ext}`;
          break;
        }
      }
    }
    const result = resolved ?? target;
    cache.set(target, result);
    return result;
  };
}

/** Map a specifier imported from `fromRel` to a repo-relative path, or null if external. */
function specifierTarget(spec, fromRel) {
  let target;
  if (spec.startsWith("@/")) target = `src/${spec.slice(2)}`;
  else if (spec === "@omniroute/open-sse") target = "open-sse";
  else if (spec.startsWith("@omniroute/open-sse/")) {
    target = `open-sse/${spec.slice("@omniroute/open-sse/".length)}`;
  } else if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    target = path.posix.join(path.posix.dirname(fromRel), spec);
  } else return null;
  target = path.posix.normalize(target).replace(/\/$/, "");
  if (target.startsWith("../") || target === "..") return null;
  return target;
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Measure the boundary under `root`. Returns
 * `{ generatedAt, files, edges, openSseToSrcEdges, bySubsystem }`.
 */
export function measureBoundary({ root, now = new Date() } = {}) {
  const absRoot = path.resolve(root ?? process.cwd());
  const resolve = createResolver(absRoot);
  const files = {};
  for (const top of SCANNED_ROOTS) files[top] = listSourceFiles(absRoot, top);

  const subsystems = new Map();
  const getSub = (name) => {
    let entry = subsystems.get(name);
    if (!entry) {
      entry = {
        name,
        files: 0,
        importsOpenSse: 0,
        importedByOpenSse: 0,
        importsSrc: 0,
        importedBySrc: 0,
        targets: new Map(),
      };
      subsystems.set(name, entry);
    }
    return entry;
  };

  const edges = { srcToOpenSse: 0, openSseToSrc: 0 };
  const openSseToSrcEdges = [];

  for (const top of SCANNED_ROOTS) {
    for (const rel of files[top]) {
      const fromSub = getSub(subsystemOf(rel));
      fromSub.files++;
      const source = fs.readFileSync(path.join(absRoot, rel), "utf8");
      const seenTargets = new Set();
      for (const spec of extractImportSpecifiers(source)) {
        const raw = specifierTarget(spec, rel);
        if (!raw) continue;
        const to = resolve(raw);
        const toTop = to.split("/")[0];
        if (toTop === top || !SCANNED_ROOTS.includes(toTop)) continue;
        if (seenTargets.has(to)) continue;
        seenTargets.add(to);

        const toSub = getSub(subsystemOf(to));
        fromSub.targets.set(to, (fromSub.targets.get(to) ?? 0) + 1);
        if (top === "src") {
          edges.srcToOpenSse++;
          fromSub.importsOpenSse++;
          toSub.importedBySrc++;
        } else {
          edges.openSseToSrc++;
          fromSub.importsSrc++;
          toSub.importedByOpenSse++;
          openSseToSrcEdges.push({ from: rel, to });
        }
      }
    }
  }

  openSseToSrcEdges.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));

  const weight = (s) => s.importsOpenSse + s.importedByOpenSse + s.importsSrc + s.importedBySrc;
  const bySubsystem = [...subsystems.values()]
    .map((s) => ({
      name: s.name,
      files: s.files,
      importsOpenSse: s.importsOpenSse,
      importedByOpenSse: s.importedByOpenSse,
      importsSrc: s.importsSrc,
      importedBySrc: s.importedBySrc,
      topTargets: [...s.targets.entries()]
        .map(([target, count]) => ({ target, count }))
        .sort((a, b) => b.count - a.count || compareStrings(a.target, b.target))
        .slice(0, TOP_TARGETS),
    }))
    .sort((a, b) => weight(b) - weight(a) || compareStrings(a.name, b.name));

  return {
    generatedAt: now.toISOString(),
    files: { src: files.src.length, openSse: files["open-sse"].length },
    edges,
    openSseToSrcEdges,
    bySubsystem,
  };
}

/** Render a measurement as Markdown (only subsystems with cross-boundary edges). */
export function renderMarkdown(result) {
  const lines = [
    `# src ⇄ open-sse boundary — ${result.generatedAt}`,
    "",
    "Generated by `scripts/quality/measure-boundary.mjs` (edges = unique importing-file → imported-file pairs).",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| src files scanned | ${result.files.src} |`,
    `| open-sse files scanned | ${result.files.openSse} |`,
    `| src → open-sse edges | ${result.edges.srcToOpenSse} |`,
    `| open-sse → src edges | ${result.edges.openSseToSrc} |`,
    "",
    "## By subsystem",
    "",
    "| Subsystem | Files | Imports open-sse | Imported by open-sse | Imports src | Imported by src | Top targets |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const s of result.bySubsystem) {
    if (s.importsOpenSse + s.importedByOpenSse + s.importsSrc + s.importedBySrc === 0) continue;
    const targets = s.topTargets.map((t) => `\`${t.target}\` (${t.count})`).join(", ") || "—";
    lines.push(
      `| \`${s.name}\` | ${s.files} | ${s.importsOpenSse} | ${s.importedByOpenSse} | ${s.importsSrc} | ${s.importedBySrc} | ${targets} |`
    );
  }
  lines.push("", "## open-sse → src edges (v4 remediation list)", "");
  if (result.openSseToSrcEdges.length === 0) lines.push("_none_");
  for (const edge of result.openSseToSrcEdges) {
    lines.push(`- \`${edge.from}\` → \`${edge.to}\``);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Ratchet (quality-baseline.json → metrics.boundaryOpenSseToSrc)
// ---------------------------------------------------------------------------

/** Key of the `open-sse → src` ceiling inside `quality-baseline.json` → `metrics`. */
export const BOUNDARY_METRIC_KEY = "boundaryOpenSseToSrc";

/** Default location of the baseline, resolved from this script's own path. */
export function defaultBaselinePath() {
  return fileURLToPath(new URL("../../config/quality/quality-baseline.json", import.meta.url));
}

/**
 * Read the frozen `open-sse → src` ceiling. Missing file, missing metric or a non-numeric
 * value ⇒ `null` (advisory: no ceiling to enforce).
 *
 * @param {string} [baselinePath]
 * @returns {number | null}
 */
export function readBaselineBoundaryValue(baselinePath = defaultBaselinePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    const value = parsed?.metrics?.[BOUNDARY_METRIC_KEY]?.value;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Compare the measured `open-sse → src` edge count with the ceiling.
 *
 * @param {number} measured
 * @param {number | null} ceiling
 * @returns {{ status: "ok" | "fail" | "advisory", exitCode: 0 | 1, message: string }}
 */
export function evaluateBoundaryRatchet(measured, ceiling) {
  if (ceiling === null || ceiling === undefined) {
    return {
      status: "advisory",
      exitCode: 0,
      message: `[boundary] RATCHET ADVISORY - no metrics.${BOUNDARY_METRIC_KEY} ceiling in quality-baseline.json; not enforced (${measured} edges, no ceiling).`,
    };
  }
  if (measured > ceiling) {
    return {
      status: "fail",
      exitCode: 1,
      message: `[boundary] RATCHET FAIL - open-sse → src edges exceed the quality-baseline.json ceiling (${measured} edges, ceiling ${ceiling}). The engine must not gain new imports from src/: move the code into open-sse/ or inject it. Run \`npm run quality:boundary\` for the full edge list. Do not raise the ceiling to make this gate green.`,
    };
  }
  return {
    status: "ok",
    exitCode: 0,
    message: `[boundary] RATCHET OK - open-sse → src edges within the quality-baseline.json ceiling (${measured} edges, ceiling ${ceiling}).`,
  };
}

/**
 * Write `measured` as the new ceiling. Refuses to raise an existing ceiling (the ratchet
 * only goes down); a missing metric is seeded as a dedicated down-only gate. Every other
 * key of the baseline — including the metric's `_note` — is preserved.
 *
 * @param {string} baselinePath
 * @param {number} measured
 * @returns {{ written: boolean, previous: number | null, value: number }}
 */
export function updateBaselineBoundaryValue(baselinePath, measured) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  baseline.metrics ??= {};
  const spec = baseline.metrics[BOUNDARY_METRIC_KEY];
  const previous = typeof spec?.value === "number" ? spec.value : null;
  if (previous !== null && measured > previous) {
    return { written: false, previous, value: measured };
  }
  baseline.metrics[BOUNDARY_METRIC_KEY] = spec
    ? { ...spec, value: measured }
    : { value: measured, direction: "down", dedicatedGate: true };
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  return { written: true, previous, value: measured };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    format: "md",
    root: process.cwd(),
    baseline: null,
    ratchet: false,
    update: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.format = "json";
    else if (arg === "--md") args.format = "md";
    else if (arg === "--ratchet") args.ratchet = true;
    else if (arg === "--update") args.update = true;
    else if (arg === "--root") args.root = argv[++i];
    else if (arg.startsWith("--root=")) args.root = arg.slice("--root=".length);
    else if (arg === "--baseline") args.baseline = argv[++i];
    else if (arg.startsWith("--baseline=")) args.baseline = arg.slice("--baseline=".length);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.ratchet && args.update) throw new Error("--ratchet and --update are exclusive");
  return args;
}

function runUpdate(baselinePath, measured) {
  let outcome;
  try {
    outcome = updateBaselineBoundaryValue(baselinePath, measured);
  } catch (error) {
    console.error(`[boundary] cannot update ${baselinePath}: ${error.message}`);
    return 2;
  }
  if (!outcome.written) {
    console.error(
      `[boundary] UPDATE refused - measured ${measured} edges is above the ceiling of ${outcome.previous}; the ceiling only goes down. Remove the new open-sse → src imports instead.`
    );
    return 1;
  }
  console.log(
    `[boundary] UPDATE - metrics.${BOUNDARY_METRIC_KEY}.value ${outcome.previous ?? "(unset)"} → ${measured}.`
  );
  return 0;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[measure-boundary] ${error.message}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(
      "Usage: node scripts/quality/measure-boundary.mjs [--json|--md] [--ratchet|--update] [--root <dir>] [--baseline <file>]"
    );
    return;
  }
  const result = measureBoundary({ root: args.root });
  const baselinePath = path.resolve(args.baseline ?? defaultBaselinePath());

  if (args.update) process.exit(runUpdate(baselinePath, result.edges.openSseToSrc));

  if (args.ratchet) {
    const verdict = evaluateBoundaryRatchet(
      result.edges.openSseToSrc,
      readBaselineBoundaryValue(baselinePath)
    );
    (verdict.status === "ok" ? console.log : console.error)(verdict.message);
    process.exit(verdict.exitCode);
  }

  process.stdout.write(
    args.format === "json" ? `${JSON.stringify(result, null, 2)}\n` : renderMarkdown(result)
  );
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
