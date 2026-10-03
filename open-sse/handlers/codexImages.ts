import { getCodexBackendIdentityHeaders } from "../config/codexClient.ts";
import { isCodexFreePlan } from "../config/codexPlan.ts";
import { getConfiguredTimeout } from "@/shared/utils/fetchTimeout";

const IMAGE_MODELS = new Set(["gpt-image-2", "gpt-image-2.5-sunburst"]);
const BODY_FIELDS = new Set(["model", "prompt", "n", "size", "quality", "background", "response_format", "image", "images"]);
const WARNING = "Requested image model, account entitlement and output dimensions are not verified by HTTP success; inspect the original output.";
type ReferenceImage = { bytes: Buffer; mime: string };
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

// The route's existing validation imports the credential DB; keep this transport state-free.
function parseInlineReference(value: unknown): ReferenceImage | null {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_REFERENCE_BYTES / 3) * 4 + 64) return null;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match || match[2].length % 4 !== 0) return null;
  const bytes = Buffer.from(match[2], "base64");
  return bytes.toString("base64") === match[2] ? { bytes, mime: match[1].toLowerCase() } : null;
}

function validateReferences(images: ReferenceImage[]): string | null {
  if (images.length > 5) return "Codex Images accepts at most 5 reference images";
  let total = 0;
  for (const image of images) {
    const mime = image.mime.trim().toLowerCase();
    const bytes = image.bytes;
    total += bytes.length;
    if (total > MAX_REFERENCE_BYTES) return "Codex Images references exceed the 20 MiB decoded limit";
    const valid = mime === "image/png" ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : mime === "image/jpeg" ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mime === "image/webp" && bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!valid) return "Codex Images reference content must match PNG, JPEG or WebP MIME";
  }
  return null;
}
type Metadata = { warning: string; imagegenRequestId?: string; requestId?: string };
type Result =
  | { success: true; data: Record<string, unknown>; metadata: Metadata }
  | { success: false; status: number; error: string; retryable: false; metadata: Metadata };

/** Explicit image engines only; hosted chat orchestration remains a separate transport. */
export function isCodexImagesModel(model: string): boolean {
  return IMAGE_MODELS.has(model);
}

/** Single JSON POST through the selected fetch/proxy context, never upload, retry or fallback. */
export async function handleCodexImages({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  log,
  referenceImages,
  operation,
  signal = null,
}: {
  model: string;
  provider: string;
  providerConfig: { baseUrl: string };
  body: Record<string, unknown>;
  credentials?: { accessToken?: string; apiKey?: string; providerSpecificData?: Record<string, unknown> } | null;
  log?: { info: (tag: string, message: string) => void; warn: (tag: string, message: string) => void; error: (tag: string, message: string) => void } | null;
  referenceImages?: ReferenceImage[];
  operation?: "generations" | "edits";
  signal?: AbortSignal | null;
}): Promise<Result> {
  const metadata: Metadata = { warning: WARNING };
  const fail = (status: number, error: string): Result => {
    log?.error("IMAGE", `Codex Images request failed (${status}); details and inputs withheld`);
    return { success: false, status, error, retryable: false, metadata };
  };
  if (provider !== "codex" || !isCodexImagesModel(model)) return fail(400, "Unsupported dedicated Codex image model");
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "Invalid Codex Images request body");
  if (Object.keys(body).some((key) => !BODY_FIELDS.has(key))) return fail(400, "Unsupported Codex Images parameter; masks and output-format controls are not supported");
  if (typeof body.prompt !== "string" || !body.prompt.trim()) return fail(400, "Prompt is required for Codex Images");
  if (body.n !== undefined && body.n !== 1) return fail(400, "Codex Images supports n=1 only");
  if (body.response_format !== undefined && body.response_format !== "b64_json") return fail(400, "Codex Images returns original b64_json only");
  if (body.size !== undefined && (typeof body.size !== "string" || !/^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/.test(body.size))) return fail(400, "Invalid Codex Images size; use auto or WIDTHxHEIGHT");
  if (body.quality !== undefined && !["low", "medium", "high", "auto"].includes(body.quality as string)) return fail(400, "Unsupported Codex Images quality");
  if (body.background !== undefined && !["transparent", "opaque", "auto"].includes(body.background as string)) return fail(400, "Unsupported Codex Images background");
  const hasImage = Object.hasOwn(body, "image");
  const hasImages = Object.hasOwn(body, "images");
  if ((hasImage && hasImages) || (referenceImages !== undefined && (hasImage || hasImages))) return fail(400, "Ambiguous Codex image references; supply one reference set");
  let images: Array<ReferenceImage | null>;
  if (referenceImages !== undefined) images = referenceImages;
  else {
    if (hasImages && !Array.isArray(body.images)) return fail(400, "Codex Images images must be an array");
    const candidates = hasImages ? body.images as unknown[] : hasImage ? [body.image] : [];
    images = candidates.map((value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const ref = value as Record<string, unknown>;
        if (Object.keys(ref).length !== 1 || !Object.hasOwn(ref, "image_url")) return null;
        return parseInlineReference(ref.image_url);
      }
      return parseInlineReference(value);
    });
  }
  if (!Array.isArray(images) || images.some((image) => !image || !Buffer.isBuffer(image.bytes) || typeof image.mime !== "string")) return fail(400, "Invalid Codex reference; use inline PNG, JPEG or WebP bytes, not remote URLs or file IDs");
  const references = images as ReferenceImage[];
  const referenceError = validateReferences(references);
  if (referenceError) return fail(400, referenceError);
  const endpoint = operation ?? (references.length ? "edits" : "generations");
  if (!["generations", "edits"].includes(endpoint) || (endpoint === "edits" && !references.length) || (endpoint === "generations" && references.length) || ((hasImage || hasImages) && !references.length)) return fail(400, "Reference images do not match the Codex Images operation");
  const token = credentials?.accessToken || credentials?.apiKey;
  if (!token) return fail(401, "Codex credentials missing accessToken — reconnect the Codex provider");
  if (isCodexFreePlan(credentials?.providerSpecificData)) return fail(403, "Codex Images requires a paid ChatGPT/Codex plan");
  let url: URL;
  try {
    url = new URL(providerConfig.baseUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash || !/\/codex\/responses\/?$/.test(url.pathname)) return fail(500, "Codex Images requires a configured Codex Responses endpoint");
    url.pathname = url.pathname.replace(/\/responses\/?$/, `/images/${endpoint}`);
  } catch {
    return fail(500, "Invalid Codex Images provider endpoint");
  }
  const upstreamBody: Record<string, unknown> = { model, prompt: body.prompt, n: 1 };
  for (const key of ["size", "quality", "background"]) if (body[key] !== undefined) upstreamBody[key] = body[key];
  if (references.length) upstreamBody.images = references.map((image) => ({ image_url: `data:${image.mime.trim().toLowerCase()};base64,${image.bytes.toString("base64")}` }));
  const headers: Record<string, string> = { ...getCodexBackendIdentityHeaders(), "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` };
  const workspaceId = credentials?.providerSpecificData?.workspaceId;
  if (typeof workspaceId === "string" && workspaceId) {
    headers["chatgpt-account-id"] = workspaceId;
    headers.session_id = workspaceId;
  }
  if (signal?.aborted) return fail(499, "Codex Images request cancelled before submission");
  const timeoutMs = getConfiguredTimeout();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0xffffffff) return fail(500, "Invalid Codex Images timeout configuration");
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  log?.info("IMAGE", "Submitting one dedicated Codex Images request; inputs and account withheld");
  try {
    const response = await fetch(url.toString(), { method: "POST", headers, body: JSON.stringify(upstreamBody), signal: requestSignal });
    for (const [header, key] of [["x-codex-imagegen-request-id", "imagegenRequestId"], ["x-request-id", "requestId"]] as const) {
      const id = response.headers.get(header);
      if (id && /^[A-Za-z0-9._:-]{1,200}$/.test(id)) metadata[key] = id;
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Upstream error bodies may echo prompts, images or credentials; never expose them.
      return fail(response.status, `Codex Images provider rejected the request (HTTP ${response.status}); details withheld`);
    }
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return fail(502, "Codex Images returned invalid image JSON; do not resubmit an unknown outcome");
    const payload = data as Record<string, unknown>;
    if (!Number.isSafeInteger(payload.created) || (payload.created as number) < 0 || !Array.isArray(payload.data) || !payload.data.length || payload.data.some((item) => !item || typeof item.b64_json !== "string" || !item.b64_json.trim())) return fail(502, "Codex Images returned no usable image data; do not resubmit an unknown outcome");
    log?.warn("IMAGE", WARNING);
    return { success: true, data: payload, metadata };
  } catch {
    if (signal?.aborted) return fail(499, "Codex Images request cancelled; outcome may be unknown, do not resubmit");
    if (timeout.aborted) return fail(504, "Codex Images request timed out; outcome may be unknown, do not resubmit");
    return fail(502, "Codex Images request or response failed; outcome may be unknown, do not resubmit");
  }
}
