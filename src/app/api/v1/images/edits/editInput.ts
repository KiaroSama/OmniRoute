import { z } from "zod";
import * as log from "@/sse/utils/logger";
import { extractImageEditInputFromJson } from "@/lib/images/imageRouteModel";
import { getBodySizeLimit, readRequestBodyWithLimit } from "@/shared/middleware/bodySizeGuard";
import { getCachedSettings } from "@/lib/db/readCache";
// JSON edit body (Open WebUI / OpenAI-style). All fields optional — the prompt
// and resolvable image are enforced after extraction in POST — but the top-level
// shape must be an object with correctly-typed fields, so a malformed body
// (array, string, wrong types) is rejected with 400 instead of silently parsed.
const ImageEditJsonSchema = z
  .object({
    prompt: z.string().optional(),
    model: z.string().optional(),
    size: z.string().optional(),
    response_format: z.string().optional(),
    image: z.unknown().optional(),
    images: z.array(z.unknown()).optional(),
  })
  .passthrough();
export interface EditInput {
  nativeOptions: Record<string, unknown>;
  aspectRatio: string | null;
  imageSize: string | null;
  hasMask: boolean;
  prompt: string;
  model: string | null;
  size: string | null;
  responseFormat: string | null;
  imageBytes: Buffer | null;
  imageMime: string | null;
  images: Array<{ bytes: Buffer; mime: string }>;
  imageInputCount: number;
}

// Keep unsupported controls too so a native transport can reject rather than drop them.
function nativeEditOptions(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !["model", "prompt", "size", "response_format", "image", "images", "image[]"].includes(key)));
}

async function readMultipartImage(formData: FormData): Promise<EditInput> {
  const promptRaw = formData.get("prompt");
  const prompt = typeof promptRaw === "string" ? promptRaw : "";
  const modelRaw = formData.get("model");
  const model = typeof modelRaw === "string" ? modelRaw.trim() : null;
  const sizeRaw = formData.get("size");
  const size = typeof sizeRaw === "string" ? sizeRaw.trim() : null;
  const respRaw = formData.get("response_format");
  const responseFormat = typeof respRaw === "string" ? respRaw.trim() : null;

  // OpenAI-style clients may repeat either `image` or `image[]`. Count every submitted
  // candidate so provider-specific cardinality checks cannot silently drop extras.
  const imageEntries = Array.from(formData.entries())
    .filter(([key]) => key === "image" || key === "image[]")
    .map(([, value]) => value);
  const images: Array<{ bytes: Buffer; mime: string }> = [];
  for (const imageEntry of imageEntries) {
    if (typeof imageEntry === "string") continue;
    const file = imageEntry as File;
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length === 0) continue;
    images.push({ bytes, mime: file.type || "image/png" });
  }
  const firstImage = images[0] ?? null;
  const nativeOptions = nativeEditOptions(Object.fromEntries(formData.entries()));
  if (Object.hasOwn(nativeOptions, "n")) nativeOptions.n = nativeOptions.n === "1" ? 1 : nativeOptions.n;
  const duplicateOptions = [...formData.keys()].some((key) => !["image", "image[]"].includes(key) && formData.getAll(key).length > 1);
  if (duplicateOptions) nativeOptions.duplicate_options = true;
  return {
    nativeOptions,
    aspectRatio: typeof formData.get("aspect_ratio") === "string" ? String(formData.get("aspect_ratio")) : null,
    imageSize: typeof formData.get("image_size") === "string" ? String(formData.get("image_size")) : null,
    hasMask: formData.has("mask") || formData.has("mask_url"),
    prompt,
    model,
    size,
    responseFormat,
    imageBytes: firstImage?.bytes ?? null,
    imageMime: firstImage?.mime ?? null,
    images,
    imageInputCount: imageEntries.length,
  };
}

/** Read the edit input from either multipart/form-data or a JSON/data-URL body. */
export async function readEditInput(request: Request): Promise<EditInput | null> {
  const contentType = request.headers.get("content-type") || "";
  let bodySizeSettings: Record<string, unknown> | undefined;
  try {
    bodySizeSettings = await getCachedSettings();
  } catch {
    bodySizeSettings = undefined;
  }
  const bodySizeLimit = getBodySizeLimit("/api/v1/images/edits", bodySizeSettings);
  const rawBody = await readRequestBodyWithLimit(request, bodySizeLimit);
  if (contentType.includes("multipart/form-data")) {
    try {
      const formData = await new Response(rawBody, {
        headers: { "content-type": contentType },
      }).formData();
      return await readMultipartImage(formData);
    } catch (err) {
      log.warn("IMAGE", `Invalid multipart body: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }
  if (contentType.includes("application/json")) {
    try {
      const parsed = ImageEditJsonSchema.safeParse(
        JSON.parse(new TextDecoder().decode(rawBody)) as unknown
      );
      if (!parsed.success) {
        log.warn("IMAGE", `Invalid JSON edit body shape: ${parsed.error.message}`);
        return null;
      }
      return {
        ...extractImageEditInputFromJson(parsed.data),
        nativeOptions: nativeEditOptions(parsed.data),
        prompt: typeof parsed.data.prompt === "string" ? parsed.data.prompt : "",
        aspectRatio: typeof parsed.data.aspect_ratio === "string" ? parsed.data.aspect_ratio : null,
        imageSize: typeof parsed.data.image_size === "string" ? parsed.data.image_size : null,
        hasMask: Object.hasOwn(parsed.data, "mask") || Object.hasOwn(parsed.data, "mask_url"),
      };
    } catch (err) {
      log.warn("IMAGE", `Invalid JSON edit body: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }
  return null;
}
