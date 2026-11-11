import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const logLevels = new Set(["INFO", "WARNING", "ERROR", "DEBUG"]);

function log(level: string, message: string) {
  assert.ok(logLevels.has(level), "Unsupported log level");
  console.log(`${new Date().toISOString()} [${level}] ${message}`);
}

const config = readFileSync(new URL("../../.gitleaks.toml", import.meta.url), "utf8");
const globalAllowlist = config.split(/^\[allowlist\]\s*$/m)[1]?.split(/^\[/m)[0];
assert.ok(globalAllowlist, "The global scanner allowlist must be available for validation");
const pathsBlock = globalAllowlist.match(/^\s*paths\s*=\s*\[([\s\S]*?)^\s*\]/m)?.[1];
assert.ok(pathsBlock, "The global scanner path exclusions must be available for validation");

// The policy uses TOML literal strings; preserve their regex escapes verbatim.
const excludedPaths = [...pathsBlock.matchAll(/'''([\s\S]*?)'''/g)].map(
  (match) => new RegExp(match[1])
);
assert.ok(excludedPaths.length > 0, "The scanner directory exclusions must not be empty");
log("DEBUG", `Loaded ${excludedPaths.length} exclusions from the actual scanner policy.`);
log("INFO", "Validating scanner directory exclusions and source-file coverage.");

test("Gitleaks scans workflow and source paths containing directory-like substrings", () => {
  for (const file of [
    ".github/workflows/ci.yml",
    "src/distance.ts",
    "src/redistribution.ts",
    "src/coverageSettings.ts",
    "src/node_modules_config.ts",
    "src/.nextVersion.ts",
  ]) {
    assert.equal(
      excludedPaths.some((pattern) => pattern.test(file)),
      false,
      `The scanner must inspect ${file}`
    );
  }
});

test("Gitleaks retains exclusions for actual generated directories", () => {
  for (const file of [
    "node_modules/module/index.js",
    "package/node_modules/module/index.js",
    ".next/server/page.js",
    "dist/output.js",
    "package/dist/output.js",
    ".git/config",
    "coverage/report.js",
    ".nyc_output/report.json",
  ]) {
    assert.equal(
      excludedPaths.some((pattern) => pattern.test(file)),
      true,
      `The existing generated-directory exclusion must still cover ${file}`
    );
  }
});
