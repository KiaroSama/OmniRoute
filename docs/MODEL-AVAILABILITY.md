# Antigravity image model availability

Checked 2026-10-04. Target: OmniRoute 3.8.51, pinned source
`c1e30b7676975feb298b49eff6ff58923c04b89e`, plus this local image repair.

## Diagnosis of the second model

The reported request selected `antigravity/gemini-3-pro-image` and returned upstream
HTTP 404 / `NOT_FOUND`. **The evidence does not establish a wrong model spelling or
an account-entitlement root cause.** Do not rename the request to a preview ID or
replace it with the working Flash model automatically.

The historical failure is recorded in the repair specification, but its sanitized raw
request/response receipt was not available in the scoped workspace during this review.
The 404 is therefore a reported observation, not a newly reproduced provider result.
No live provider call, credential lookup or private account database inspection was
performed for this diagnosis.

## What the pinned source proves

1. The Antigravity image provider uses OAuth and the Cloud Code
   `v1internal:generateContent` operation. Its image catalog contains only
   `gemini-3.1-flash-image`; it does not register Gemini 3 Pro Image. See the
   [pinned image registry, lines 400–407](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/open-sse/config/imageRegistry.ts#L400-L407).
2. The general Antigravity alias map translates `gemini-3-pro-image-preview` **to**
   `gemini-3-pro-image`. Its reverse map is a client/quota display conversion, not
   evidence that the upstream image operation needs the preview spelling. See
   [pinned aliases](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/open-sse/config/antigravityModelAliases.ts#L25-L58).
3. The image parser accepts an explicit provider prefix even when its model is absent
   from the static catalog. The original image generator writes the parsed model
   directly into the Cloud Code envelope; it does not run the chat executor's alias
   resolver. Consequently a generation request for the exact native Pro ID can reach
   upstream without being an advertised image-catalog entry. See
   [pinned parser](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/open-sse/config/imageRegistry.ts) and
   [pinned image generator, lines 1098–1119](https://github.com/diegosouzapw/OmniRoute/blob/c1e30b7676975feb298b49eff6ff58923c04b89e/open-sse/handlers/imageGeneration.ts#L1098-L1119).
4. The local repair preserves the selected native ID and envelope. Reference edits
   require exact image-catalog membership, so the unregistered Pro model is rejected
   locally with 400 before submission. That guard is not a claim that Google lacks
   the model; it says this checkout has not established that edit route. Relevant
   local contracts are `open-sse/handlers/geminiImage.ts`,
   `open-sse/config/imageProviderCatalog.ts` and
   `src/app/api/v1/images/edits/editDispatch.ts`.

## Public model existence is not OAuth availability

Google's current [Gemini 3 Pro Image model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image)
identifies stable model code `gemini-3-pro-image`, image/text inputs and image/text
outputs. The page was last updated 2026-09-03 UTC. This confirms the public Gemini API
model exists; it does **not** prove availability on Antigravity's distinct Cloud Code
operation, selected OAuth account, project or client profile.

The pinned alias source also treats image model quota visibility separately from chat
callability. A visible quota bucket, a model menu, and successful generation by
`gemini-3.1-flash-image` cannot establish Pro image entitlement.

Upstream [issue 2334](https://github.com/diegosouzapw/OmniRoute/issues/2334) describes an
older 3.8.0 `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT` against the public Gemini service.
That different status and service do not explain the reported Cloud Code 404 in this
3.8.51 task. [Issue 14545](https://github.com/diegosouzapw/OmniRoute/issues/14545) describes
catalog/direct-call asymmetry on other image routes; it supports separating registry
membership from upstream success, not a Pro-account entitlement conclusion.

## What remains unknown

The reported 404 is consistent with a model unavailable to that particular upstream
route/account/project at that time, but the response alone cannot distinguish a
retired or unavailable upstream slot from account/project access or another missing
entity. There is no verified alternate native ID or endpoint fix in this review.

Before enabling Pro edits, obtain authorized, sanitized evidence from the same account,
project and client profile: its authenticated available-image-model result and a
controlled request using the exact native ID. Keep authorization, selected identity,
original references and result dimensions explicit. Do not retry an ambiguous paid
submission, switch accounts/models, upload a reference elsewhere or resize locally to
manufacture success. Account availability remains **unverified** until that evidence
exists.

## Verification scope

This document is a read-only source and public-documentation diagnosis. Existing
fixture tests prove local reference dispatch and guards, not Pro availability or
paid-provider success. No runtime, full suite, deployment or live model check was run
for this document. No source behavior or chosen model was changed.
