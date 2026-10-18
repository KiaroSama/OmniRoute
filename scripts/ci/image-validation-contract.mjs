import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";

export const IMAGE_BASELINE = "1591cd55e0c2b4195cb41ea9e1967d3eb8f56d5e";

export const IMAGE_REGRESSIONS = [
  "10197-openrouter-image-edits-route.test.ts",
  "codex-free-plan-image-generation.test.ts",
  "codex-images-dedicated-endpoint.test.ts",
  "codex-spark-image-generation.test.ts",
  "hard-session-lease-bypass-inventory.test.ts",
  "proxySubscription.parse.test.ts",
  "image-normalize.test.ts",
  "image-accounting-adapters.test.ts",
  "image-usage-accounting.test.ts",
  "t42-image-size-to-aspect-ratio.test.ts",
  "fal-image-edit.test.ts",
  "fal-image-generation-default.test.ts",
  "nanobanana-image-handler.test.ts",
  "muse-image-provider.test.ts",
  "nan-provider.test.ts",
  "combo/image-combo.test.ts",
  "combo/image-combo-empty-200-fallback.test.ts",
].map((file) => `tests/unit/${file}`);

export function validateImageSelection({ candidate, actual, workflow, admitted }) {
  assert.ok(
    typeof candidate === "string" && candidate.length === 40 && /^[0-9a-f]+$/.test(candidate),
    "Expected lowercase40hex candidate"
  );
  assert.ok(
    typeof workflow === "string" && workflow.length === 40 && /^[0-9a-f]+$/.test(workflow),
    "Expected immutable workflow source"
  );
  assert.equal(actual, candidate, "Checkout differs from selected candidate");
  assert.equal(admitted, true, "Candidate does not descend from the admitted base");
  return { candidate, workflow, baseline: IMAGE_BASELINE };
}

export function selectImageFiles(files, changed = []) {
  const available = new Set(files);
  for (const file of IMAGE_REGRESSIONS) {
    assert.ok(available.has(file), `Required image regression missing: ${file}`);
  }
  const selected = files.filter((file) =>
    /^tests\/unit\/(?:native-(?:codex|antigravity|image)|antigravity-image-|image-(?:generation|edits|credential|registry|routes|combo-edits|upscale-error))[^/]*\.test\.ts$/.test(
      file
    )
  );
  return [
    ...new Set([
      ...selected,
      ...IMAGE_REGRESSIONS,
      ...changed.filter(
        (file) => available.has(file) && /^tests\/unit\/.*\.test\.(?:ts|mjs)$/.test(file)
      ),
    ]),
  ].sort();
}

export function discoverNativeBuckets(root) {
  const { scripts } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const commands = scripts["test:unit:ci:shard"].split(" && ");
  assert.equal(commands.length, 3, "Canonical native collector count changed");
  const seen = new Set();
  return commands.map((command, index) => {
    const patterns = [
      ...command.matchAll(/(?:"([^"]+\.test\.(?:ts|mjs))"|(tests\/\S+\.test\.(?:ts|mjs)))/g),
    ].map((match) => match[1] ?? match[2]);
    assert.ok(patterns.length, `Native bucket ${index + 1} has no test patterns`);
    const files = [
      ...new Set(globSync(patterns, { cwd: root }).map((file) => file.replaceAll("\\", "/"))),
    ].sort();
    assert.ok(files.length, `Native bucket ${index + 1} is empty`);
    for (const file of files) {
      assert.ok(!seen.has(file), `Native suite collected twice: ${file}`);
      seen.add(file);
    }
    return {
      name: ["unit", "dashboard", "serial"][index],
      loader: index === 1 ? "tsx" : "tsx/esm",
      files,
    };
  });
}

export function imageWorkerDirectory(owned, checkId, pid) {
  assert.ok(
    typeof checkId === "string" &&
      checkId.length > 0 &&
      checkId.length <= 60 &&
      !/[^a-z0-9-]/.test(checkId),
    "Invalid image check identity"
  );
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "Invalid worker PID");
  return path.join(owned, "workers", checkId, String(pid));
}

export function ownedDescendants(snapshot, owners) {
  const owned = new Map(owners);
  let added;
  do {
    added = false;
    for (const [pid, item] of snapshot) {
      const parent = owned.get(item.parent);
      const newer =
        parent &&
        (/^\d+$/.test(item.start) && /^\d+$/.test(parent.start)
          ? BigInt(item.start) >= BigInt(parent.start)
          : item.start >= parent.start);
      if (!owned.has(pid) && parent && snapshot.get(item.parent)?.start === parent.start && newer) {
        owned.set(pid, item);
        added = true;
      }
    }
  } while (added);
  return owned;
}

export function partitionNativeFiles(buckets, focused, shard, total) {
  assert.ok(Number.isSafeInteger(total) && total > 0 && total <= 32, "Invalid shard count");
  assert.ok(Number.isSafeInteger(shard) && shard >= 1 && shard <= total, "Invalid shard index");
  const excluded = new Set(focused);
  const all = new Set(buckets.flatMap((bucket) => bucket.files));
  for (const file of excluded)
    assert.ok(all.has(file), `Focused suite not in canonical collectors: ${file}`);
  return buckets.map((bucket) => ({
    ...bucket,
    files: bucket.files
      .filter((file) => !excluded.has(file))
      .filter((_, index) => index % total === shard - 1),
  }));
}
