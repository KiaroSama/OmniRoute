import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  embedStatic,
  getOrLoadModel,
  _injectModel,
} from "../../src/lib/memory/embedding/staticPotion";
import type { EmbeddingResult } from "../../src/lib/memory/embedding/types";
import { invalidate as invalidateCache } from "../../src/lib/memory/embedding/cache";

// The model repo on Hugging Face (minishlab/potion-base-8M) ships config.json,
// model.safetensors, modules.json, special_tokens_map.json, tokenizer.json,
// tokenizer_config.json and vocab.txt. It does NOT ship vocab.json (HTTP 404).
// The stubbed fetch below serves four of those names (config.json,
// model.safetensors, tokenizer.json, vocab.txt) with small made-up contents and
// answers every other name, vocab.json included, with a 404. The loader is
// therefore exercised without network access.

// Same token order as the real vocab, cut down: [UNK] sits at id 1, not 0.
const TOKENS = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]", "hello", "world", "##s"];
const DIM = 4;
// Row i of the matrix is [i, 0, 0, 0] so a pooled vector identifies the ids used.
const ROWS = TOKENS.map((_, i) => [i, 0, 0, 0]);

function buildSafetensors(rows: number[][]): Buffer {
  const dim = rows[0].length;
  const header = Buffer.from(
    JSON.stringify({
      embeddings: {
        dtype: "F32",
        shape: [rows.length, dim],
        data_offsets: [0, rows.length * dim * 4],
      },
    }),
    "utf8"
  );
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  const data = Buffer.alloc(rows.length * dim * 4);
  rows.flat().forEach((v, i) => data.writeFloatLE(v, i * 4));
  return Buffer.concat([len, header, data]);
}

function buildTokenizerJson(tokens: string[]): string {
  return JSON.stringify({
    version: "1.0",
    model: {
      type: "WordPiece",
      unk_token: "[UNK]",
      vocab: Object.fromEntries(tokens.map((t, i) => [t, i])),
    },
  });
}

const HF_FILES: Record<string, Buffer> = {
  "config.json": Buffer.from("{}"),
  "model.safetensors": buildSafetensors(ROWS),
  "tokenizer.json": Buffer.from(buildTokenizerJson(TOKENS)),
  "vocab.txt": Buffer.from(TOKENS.join("\n") + "\n"),
};

describe("memory-embedding-static-potion loader against the repo file names", () => {
  const realFetch = globalThis.fetch;
  const prevCacheDir = process.env.MEMORY_STATIC_CACHE_DIR;
  let cacheDir = "";
  let requested: string[] = [];

  beforeEach(async () => {
    invalidateCache();
    _injectModel(null);
    requested = [];
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "potion-loader-"));
    process.env.MEMORY_STATIC_CACHE_DIR = cacheDir;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      const body = HF_FILES[url.split("/").pop() ?? ""];
      if (!body) return new Response("Entry not found", { status: 404 });
      return new Response(new Uint8Array(body), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (prevCacheDir === undefined) delete process.env.MEMORY_STATIC_CACHE_DIR;
    else process.env.MEMORY_STATIC_CACHE_DIR = prevCacheDir;
    _injectModel(null);
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("loads the model on a fresh cache dir without asking for vocab.json", async () => {
    const model = await getOrLoadModel();
    assert.equal(
      requested.some((u) => u.endsWith("/vocab.json")),
      false,
      `the repo has no vocab.json, but the loader requested: ${requested.join(", ")}`
    );
    assert.equal(model.vocab["[UNK]"], 1);
    assert.equal(model.vocab["hello"], 5);
    assert.equal(model.unkIdx, 1);
  });

  it("builds a vocab as large as the embedding matrix has rows", async () => {
    const model = await getOrLoadModel();
    assert.equal(model.vocabSize, TOKENS.length);
    assert.equal(model.dim, DIM);
    assert.equal(Object.keys(model.vocab).length, model.vocabSize);
    assert.equal(model.matrix.length, model.vocabSize * model.dim);
  });

  it("embeds text through the downloaded vocab and matrix", async () => {
    const result = (await embedStatic("hello world")) as EmbeddingResult;
    assert.ok("vector" in result, `expected a vector, got ${JSON.stringify(result)}`);
    // hello = id 5, world = id 6, mean of rows [5,0,0,0] and [6,0,0,0]
    assert.deepEqual(Array.from(result.vector), [5.5, 0, 0, 0]);
  });

  it("maps an unknown word to the [UNK] row, id 1", async () => {
    const result = (await embedStatic("zzz")) as EmbeddingResult;
    assert.deepEqual(Array.from(result.vector), [1, 0, 0, 0]);
  });

  it("reuses a cache dir that already holds the downloaded files", async () => {
    await getOrLoadModel();
    _injectModel(null);
    requested = [];
    const model = await getOrLoadModel();
    assert.deepEqual(requested, []);
    assert.equal(model.vocab["world"], 6);
  });

  const NOT_A_WORDPIECE_VOCAB: Array<[string, unknown]> = [
    ["no model.vocab at all", { model: { type: "Unigram" } }],
    [
      "a Unigram-style vocab array of [token, score] pairs",
      {
        model: {
          type: "Unigram",
          vocab: [
            ["[UNK]", 0],
            ["hello", -1.5],
          ],
        },
      },
    ],
  ];

  for (const [label, tokenizerJson] of NOT_A_WORDPIECE_VOCAB) {
    it(`reports model_load_failed when tokenizer.json has ${label}`, async () => {
      HF_FILES["tokenizer.json"] = Buffer.from(JSON.stringify(tokenizerJson));
      try {
        const result = await embedStatic("hello");
        assert.ok(!("vector" in result));
        assert.equal(result.reason, "model_load_failed");
        assert.match(result.message, /model\.vocab/);
      } finally {
        HF_FILES["tokenizer.json"] = Buffer.from(buildTokenizerJson(TOKENS));
      }
    });
  }
});
