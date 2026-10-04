import { handleGeminiImageGeneration, validateAntigravityReferences } from "@omniroute/open-sse/handlers/geminiImage.ts";
import { handleAdobeFireflyImageGeneration, handleCodexImageEdit, handleOpenAIImageEdit, handleOpenRouterImageEdit } from "@omniroute/open-sse/handlers/imageGeneration.ts";
import { handleCodexImages, isCodexImagesModel } from "@omniroute/open-sse/handlers/codexImages.ts";
import { handleFalAIImageEdit, isFalImageEditModel } from "@omniroute/open-sse/handlers/imageGeneration/providers/fal.ts";

import { getProviderCredentialsWithQuotaPreflight, clearRecoveredProviderState } from "@/sse/services/auth";
import { parseImageModel, getImageProvider, getImageModelEntry } from "@omniroute/open-sse/config/imageRegistry.ts";
import { errorResponse, unavailableResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { getComboByName, getCombos } from "@/lib/db/combos";
import { resolveComboTargets } from "@omniroute/open-sse/services/combo.ts";
import { runImageComboTargets, type ImageComboDispatchResult } from "@omniroute/open-sse/services/imageCombo.ts";
import { isAllRateLimitedCredentials } from "@/app/api/v1/_shared/rateLimit";
import { isUsableImageCredentials } from "@/sse/services/imageCredentials";
import * as log from "@/sse/utils/logger";
import { toJsonErrorPayload } from "@/shared/utils/upstreamError";

import { resolveImageModelPrefix, validateCodexImageEditReferences } from "@/lib/images/imageRouteModel";

import { resolveProxyForConnection } from "@/lib/db/settings";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import { isCodexFreePlan } from "@omniroute/open-sse/config/codexPlan.ts";
import { refreshSelectedCodexImageCredentials } from "@/sse/services/selectedCodexImageCredentials";




function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Reduce reference images (multi + single fallback) to data-URL strings for Firefly. */
function buildAdobeFireflyEditDataUrls(
  images: Array<{ bytes: Buffer; mime: string }>,
  imageBytes: Buffer | null,
  imageMime: string | null
): string[] {
  const dataUrls: string[] = [];
  const refList = Array.isArray(images) ? images : [];
  for (const ref of refList) {
    if (!ref || typeof ref !== "object") continue;
    const bytes = (ref as { bytes?: Buffer }).bytes;
    const mime =
      typeof (ref as { mime?: string }).mime === "string" &&
      String((ref as { mime?: string }).mime).startsWith("image/")
        ? String((ref as { mime?: string }).mime)
        : "image/png";
    if (Buffer.isBuffer(bytes) && bytes.length > 0) {
      dataUrls.push(`data:${mime};base64,${bytes.toString("base64")}`);
    }
  }
  if (dataUrls.length === 0 && imageBytes && imageBytes.length > 0) {
    const mime =
      typeof imageMime === "string" && imageMime.startsWith("image/") ? imageMime : "image/png";
    dataUrls.push(`data:${mime};base64,${imageBytes.toString("base64")}`);
  }
  return dataUrls;
}

/**
 * Adobe Firefly edit = storage upload + generate-async referenceBlobs (same as i2i generate).
 * Extracted from postHandler to keep cyclomatic/cognitive complexity in check
 * (config/quality/complexity-baseline.json ratchet).
 */
export async function handleAdobeFireflyEditRequest(params: {
  parsed: ReturnType<typeof parseImageModel>;
  providerConfig: NonNullable<ReturnType<typeof getImageProvider>>;
  allowedConnections: string[] | null;
  resolvedModel: string;
  prompt: string;
  size: string | null;
  responseFormat: string | null;
  images: Array<{ bytes: Buffer; mime: string }>;
  imageBytes: Buffer | null;
  imageMime: string | null;
}): Promise<Response> {
  const {
    parsed,
    providerConfig,
    allowedConnections,
    resolvedModel,
    prompt,
    size,
    responseFormat,
    images,
    imageBytes,
    imageMime,
  } = params;

  const credentials = await getProviderCredentialsWithQuotaPreflight(
    parsed.provider,
    null,
    allowedConnections,
    resolvedModel
  );
  if (!credentials || "allExpired" in credentials) {
    return errorResponse(
      HTTP_STATUS.UNAUTHORIZED,
      `No credentials for provider: ${parsed.provider}`
    );
  }
  if ("blockedByKeyPolicy" in credentials) return errorResponse(403, "Image provider connection is not allowed by API key policy");
  if (isAllRateLimitedCredentials(credentials)) {
    return unavailableResponse(
      HTTP_STATUS.RATE_LIMITED,
      `[${parsed.provider}] All accounts rate limited`,
      credentials.retryAfter,
      credentials.retryAfterHuman
    );
  }

  if ("allRateLimited" in credentials) return errorResponse(503, "Image provider credentials unavailable");
  if ("leaseUnavailable" in credentials) return errorResponse(429, "Selected image account is already leased; try again later");
  if (!isUsableImageCredentials(credentials)) return errorResponse(401, "Image credential selection did not return usable credentials");
  // Prefer multi-image list when present; fall back to the primary imageBytes.
  const dataUrls = buildAdobeFireflyEditDataUrls(images, imageBytes, imageMime);
  if (dataUrls.length === 0) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: image");
  }

  const result = await handleAdobeFireflyImageGeneration({
    provider: parsed.provider,
    model: parsed.model,
    providerConfig,
    body: {
      prompt,
      size: size ?? undefined,
      response_format: responseFormat ?? undefined,
      n: 1,
      image_url: dataUrls[0],
      image: dataUrls.length === 1 ? dataUrls[0] : dataUrls,
      image_urls: dataUrls,
      images: dataUrls,
    },
    credentials,
    log,
  });

  if ((result as { success?: boolean }).success) {
    await clearRecoveredProviderState(credentials);
    return jsonResponse((result as { data?: unknown }).data);
  }
  return jsonResponse(
    toJsonErrorPayload((result as { error?: unknown }).error, "Image edit provider error"),
    (result as { status?: number }).status ?? HTTP_STATUS.BAD_GATEWAY
  );
}

/** Reference/prompt payload an edit dispatch needs, shared by single + combo paths. */
interface ImageEditContext {
  nativeOptions?: Record<string, unknown>;
  aspectRatio?: string | null;
  imageSize?: string | null;
  hasMask?: boolean;
  prompt: string;
  size: string | null;
  responseFormat: string | null;
  images: Array<{ bytes: Buffer; mime: string }>;
  imageBytes: Buffer | null;
  imageMime: string | null;
  imageInputCount: number;
  allowedConnections: string[] | null;
  request: Request;
}

/** A combo target that resolved to an edit-capable provider/node. */
interface EditComboTarget {
  modelStr: string;
  parsed: ReturnType<typeof parseImageModel>;
  providerConfig: ReturnType<typeof getImageProvider> | null;
  /** Credential/connection lookup key (built-in provider id, or custom node id). */
  credKey: string;
}

/**
 * Decide whether a prefix-resolved combo target can service an image edit, and
 * return the credential key to resolve it with. Mirrors postHandler's provider
 * branches: codex-responses, fal-ai edit models, adobe-firefly, built-in
 * openrouter, and custom OpenAI-compatible nodes are edit-capable; every other
 * built-in provider is not (it exposes no OpenAI-compatible edit endpoint).
 */
function classifyImageEditTarget(
  resolvedModel: string,
  parsed: ReturnType<typeof parseImageModel>,
  providerConfig: ReturnType<typeof getImageProvider> | null
): { credKey: string } | null {
  if (providerConfig) {
    if (
      providerConfig.format === "gemini-image" ||
      providerConfig.format === "codex-responses" ||
      providerConfig.format === "adobe-firefly-image" ||
      (providerConfig.format === "fal-ai" && isFalImageEditModel(parsed.model)) ||
      providerConfig.id === "openrouter"
    ) {
      return parsed.provider ? { credKey: parsed.provider } : null;
    }
    // Other built-in providers do not expose an OpenAI-compatible edit endpoint.
    return null;
  }
  // Custom OpenAI-compatible node: prefix already rewritten to `<nodeId>/model`.
  const slash = resolvedModel.indexOf("/");
  if (slash > 0 && slash < resolvedModel.length - 1) {
    return { credKey: resolvedModel.slice(0, slash) };
  }
  return null;
}

/**
 * Dispatch a single edit-capable target with already-resolved credentials, and
 * return a normalized {success,data,status,error}. Reuses the same provider
 * handlers postHandler uses for the single-model path.
 */
async function dispatchImageEditTarget(
  target: EditComboTarget,
  credentials: unknown,
  ctx: ImageEditContext
): Promise<ImageComboDispatchResult> {
  const { parsed, providerConfig, modelStr } = target;
  const { prompt, size, responseFormat, images, imageBytes, imageMime, request } = ctx;

  if (providerConfig?.format === "gemini-image") return dispatchAntigravityEdit(target, credentials, ctx) as Promise<ImageComboDispatchResult>;

  // Built-in Codex — native Responses hosted tool for reference-image edits.
  if (providerConfig?.format === "codex-responses") {
    if (isCodexImagesModel(parsed.model)) return dispatchCodexImagesEdit(target, credentials, ctx);
    const modelEntry = getImageModelEntry(modelStr);
    if (!modelEntry || modelEntry.provider !== "codex" || modelEntry.model !== parsed.model) {
      return { success: false, status: HTTP_STATUS.BAD_REQUEST, error: `Unsupported Codex image edit model: ${modelStr}` };
    }
    const imageValidationError = validateCodexImageEditReferences(images);
    if (imageValidationError) {
      return { success: false, status: HTTP_STATUS.BAD_REQUEST, error: imageValidationError };
    }
    const credentialDetails = credentials as {
      connectionId?: unknown;
      providerSpecificData?: unknown;
    };
    if (isCodexFreePlan(credentialDetails.providerSpecificData)) {
      return {
        success: false,
        status: HTTP_STATUS.BAD_REQUEST,
        error: "Codex image editing requires a paid ChatGPT/Codex plan",
      };
    }
    const connectionId =
      typeof credentialDetails.connectionId === "string" ? credentialDetails.connectionId : null;
    let proxyInfo = null;
    if (connectionId) {
      try {
        proxyInfo = await resolveProxyForConnection(connectionId);
      } catch {
        log.debug("PROXY", `Failed to resolve proxy for image provider: ${parsed.provider}`);
      }
    }
    const editImage = () =>
      handleCodexImageEdit({
        provider: parsed.provider,
        model: parsed.model,
        providerConfig,
        body: {
          prompt,
          size: size ?? undefined,
          response_format: responseFormat ?? undefined,
        },
        referenceImages: images,
        credentials: credentials as never,
        log,
        signal: request.signal,
      });
    return (await (connectionId
      ? runWithProxyContext(proxyInfo?.proxy || null, editImage).catch(() => ({
          success: false as const,
          status: HTTP_STATUS.SERVICE_UNAVAILABLE,
          error: "Image edit proxy error",
        }))
      : editImage())) as ImageComboDispatchResult;
  }

  if (providerConfig?.format === "fal-ai" && isFalImageEditModel(parsed.model)) {
    return (await handleFalAIImageEdit({
      provider: parsed.provider,
      model: parsed.model,
      providerConfig,
      body: { prompt, size: size ?? undefined, response_format: responseFormat ?? undefined, n: 1 },
      images,
      credentials: credentials as never,
      log,
    })) as ImageComboDispatchResult;
  }

  if (providerConfig?.format === "adobe-firefly-image") {
    const dataUrls = buildAdobeFireflyEditDataUrls(images, imageBytes, imageMime);
    if (dataUrls.length === 0) {
      return { success: false, status: HTTP_STATUS.BAD_REQUEST, error: "Missing required field: image" };
    }
    return (await handleAdobeFireflyImageGeneration({
      provider: parsed.provider,
      model: parsed.model,
      providerConfig,
      body: {
        prompt,
        size: size ?? undefined,
        response_format: responseFormat ?? undefined,
        n: 1,
        image_url: dataUrls[0],
        image: dataUrls.length === 1 ? dataUrls[0] : dataUrls,
        image_urls: dataUrls,
        images: dataUrls,
      },
      credentials: credentials as never,
      log,
    })) as ImageComboDispatchResult;
  }

  if (providerConfig?.id === "openrouter") {
    return (await handleOpenRouterImageEdit({
      provider: parsed.provider,
      model: parsed.model,
      baseUrl: providerConfig.baseUrl,
      credentials: credentials as never,
      prompt,
      imageBytes,
      imageMime,
      size: size ?? undefined,
      n: 1,
      log,
    })) as ImageComboDispatchResult;
  }

  // Custom OpenAI-compatible node: forward to {base_url}/images/edits.
  const slash = modelStr.indexOf("/");
  const customProviderId = slash > 0 ? modelStr.slice(0, slash) : null;
  const customModel = slash > 0 ? modelStr.slice(slash + 1) : null;
  if (!customProviderId || !customModel) {
    return {
      success: false,
      status: HTTP_STATUS.BAD_REQUEST,
      error: `Unknown image provider for model "${modelStr}"`,
    };
  }
  return (await handleOpenAIImageEdit({
    provider: customProviderId,
    model: customModel,
    credentials: credentials as never,
    prompt,
    imageBytes,
    imageMime,
    size,
    responseFormat,
    n: 1,
    log,
  })) as ImageComboDispatchResult;
}

/**
 * #12547: run an image-edit request whose model is a bare combo/alias name over
 * the combo's edit-capable targets, mirroring how /v1/images/generations diverts
 * bare combos to executeImageCombo (#9239). A combo whose first target isn't
 * edit-capable (or lacks credentials) now falls through to a later edit-capable
 * target instead of flattening to the first target and hard-erroring.
 */
export async function executeImageEditCombo(comboName: string, ctx: ImageEditContext): Promise<Response> {
  const combo = await getComboByName(comboName);
  if (!combo) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Combo not found: ${comboName}`);
  }
  const allCombos = await getCombos();
  const targets = resolveComboTargets(combo as never, allCombos as never);
  if (!targets || targets.length === 0) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Combo "${comboName}" has no usable targets`);
  }

  // Build the edit-capable target list (prefix-resolved). Non-edit-capable and
  // retired targets are skipped here so the loop only iterates dispatchable ones.
  const editTargets: EditComboTarget[] = [];
  for (const t of targets) {
    const raw =
      typeof (t as { modelStr?: unknown }).modelStr === "string"
        ? ((t as { modelStr: string }).modelStr as string)
        : "";
    if (!raw.trim()) continue;
    let resolved: string;
    try {
      resolved = await resolveImageModelPrefix(raw);
    } catch {
      // retired provider / prefix — skip this target
      continue;
    }
    const parsed = parseImageModel(resolved);
    const providerConfig = parsed.provider ? getImageProvider(parsed.provider) : null;
    const capability = classifyImageEditTarget(resolved, parsed, providerConfig);
    if (!capability) continue;
    editTargets.push({ modelStr: resolved, parsed, providerConfig, credKey: capability.credKey });
  }

  if (editTargets.length === 0) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `No image-edit-capable targets in combo "${comboName}"`
    );
  }

  const run = await runImageComboTargets(editTargets, {
    resolveProvider: (target) => ({ provider: target.credKey, model: target.parsed.model }),
    resolveCredentials: (_provider, target) =>
      getProviderCredentialsWithQuotaPreflight(
        target.credKey,
        null,
        ctx.allowedConnections,
        target.modelStr
      ),
    isRateLimited: isAllRateLimitedCredentials,
    dispatch: ({ target, credentials }) => dispatchImageEditTarget(target, credentials, ctx),
    onSuccess: async (credentials) => {
      await clearRecoveredProviderState(credentials as never);
    },
    failureLabel: "Image edit failed",
  });

  if (run.outcome === "terminal") {
    return errorResponse(run.status, `[${run.provider}] ${run.error}`);
  }
  if (run.outcome === "success") {
    // Match the single-model edit path: return the provider payload directly.
    return jsonResponse(run.data);
  }
  const errorPayload = toJsonErrorPayload(
    run.lastError?.error || "All combo targets failed",
    "Image edit combo targets all failed"
  );
  return new Response(JSON.stringify(errorPayload), {
    status: run.lastError?.status || HTTP_STATUS.BAD_GATEWAY,
    headers: { "Content-Type": "application/json" },
  });
}

export function validateCodexImagesEditOptions(ctx): string | null {
  if (ctx.hasMask || Object.keys(ctx.nativeOptions ?? {}).some((key) => !["n", "quality", "background"].includes(key))) return "Unsupported Codex Images edit parameter; masks and output-format controls are not supported";
  const options = ctx.nativeOptions ?? {};
  if (options.n !== undefined && options.n !== 1) return "Codex Images supports n=1 only";
  if (options.quality !== undefined && !["low", "medium", "high", "auto"].includes(options.quality)) return "Unsupported Codex Images quality";
  if (options.background !== undefined && !["transparent", "opaque", "auto"].includes(options.background)) return "Unsupported Codex Images background";
  if (ctx.responseFormat !== null && ctx.responseFormat !== undefined && ctx.responseFormat !== "b64_json") return "Codex Images returns original b64_json only";
  if (ctx.size !== null && ctx.size !== undefined && !/^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/.test(ctx.size)) return "Invalid Codex Images size; use auto or WIDTHxHEIGHT";
  return validateCodexImageEditReferences(ctx.images, 5);
}

export async function dispatchCodexImagesEdit(target, credentials, ctx): Promise<ImageComboDispatchResult> {
  const { parsed, providerConfig, modelStr } = target;
  const entry = getImageModelEntry(modelStr);
  const fail = (status, error) => ({ success: false as const, status, error, retryable: false });
  if (!entry || entry.provider !== "codex" || entry.model !== parsed.model || !isCodexImagesModel(parsed.model)) return fail(400, "Unsupported dedicated Codex image edit model");
  const validation = validateCodexImagesEditOptions(ctx);
  if (validation) return fail(400, validation);
  const refreshed = await refreshSelectedCodexImageCredentials(credentials, ctx.request.signal);
  if (refreshed.success === false) return refreshed;
  const selected = refreshed.credentials;
  try {
    const proxyInfo = selected.connectionId ? await resolveProxyForConnection(selected.connectionId) : null;
    return await runWithProxyContext(proxyInfo?.proxy || null, () => handleCodexImages({
      provider: parsed.provider, model: parsed.model, providerConfig,
      body: { ...ctx.nativeOptions, prompt: ctx.prompt, size: ctx.size ?? undefined, response_format: ctx.responseFormat ?? undefined },
      referenceImages: ctx.images, operation: "edits", credentials: selected, log, signal: ctx.request.signal,
    }));
  } catch {
    return fail(503, "Codex Images edit proxy or transport failed; do not resubmit an unknown outcome");
  }
}

export async function dispatchAntigravityEdit(target, credentials, ctx) {
  const { parsed, providerConfig, modelStr } = target;
  const entry = getImageModelEntry(modelStr);
  if (!entry || entry.provider !== "antigravity" || entry.model !== parsed.model) return { success: false, status: 400, error: "Unsupported Antigravity image edit model" };
  const validation = validateAntigravityReferences(ctx.images, ctx.hasMask);
  if (validation) return { success: false, status: 400, error: validation };
  let proxyInfo = null;
  if (credentials.connectionId) proxyInfo = await resolveProxyForConnection(credentials.connectionId);
  return runWithProxyContext(proxyInfo?.proxy || null, () => handleGeminiImageGeneration({
    model: parsed.model, providerConfig, credentials, log, signal: ctx.request.signal,
    referenceImages: ctx.images, logPath: "/v1/images/edits",
    body: { model: modelStr, prompt: ctx.prompt, size: ctx.size, response_format: ctx.responseFormat ?? undefined, aspect_ratio: ctx.aspectRatio, image_size: ctx.imageSize, n: 1 },
  }));
}
