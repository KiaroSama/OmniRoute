# Native image repair contracts

Target: OmniRoute 3.8.51 (`c1e30b7676975feb298b49eff6ff58923c04b89e`).

## Separate orchestration from image engines

`cx/gpt-6.1-sol` remains the Codex hosted image-tool orchestration route. Adding its
exact image-registry entry does not rename the image engine or promise native 4K.
The dedicated `cx/gpt-image-2` and `cx/gpt-image-2.5-sunburst` routes instead submit
one JSON request to the selected Codex backend's `images/generations` or
`images/edits` endpoint. They never translate to the hosted chat tool, rotate to
another account after submission, or silently substitute another engine.

Official Codex request and endpoint source:
- [Typed requests](https://github.com/openai/codex/blob/447eac3b81183b32c1a09f5fba9617abfacbebe3/codex-rs/codex-api/src/images.rs)
- [JSON endpoints](https://github.com/openai/codex/blob/447eac3b81183b32c1a09f5fba9617abfacbebe3/codex-rs/codex-api/src/endpoint/images.rs)
- [Tool model and five-reference limit](https://github.com/openai/codex/blob/b172810921f89847cd310ecc496f9c901760e933/codex-rs/ext/image-generation/src/tool.rs)

The public API documents the Sunburst identifier, but this is not proof that a
particular Codex OAuth account can use it, nor proof of the engine actually served.
HTTP success and forwarding the model string do not establish either claim.

## Dedicated request controls

Generation accepts `prompt`, `model`, `n=1`, optional `size`, `quality`, and
`background`. Only original `b64_json` responses are supported. Edits accept at
most five original PNG/JPEG/WebP references, at most 20 MiB decoded total; JSON
inline data URLs and multipart file inputs are normalized without resizing.
Masks, remote reference URLs, file IDs and unimplemented output controls are
rejected rather than discarded. Selected account policy, proxy and cancellation
remain in effect. Refresh failure terminates before image submission. A selected
account already held by an exclusive lease returns 429 without forwarding its
credential sentinel to an image adapter. Other diagnostic selection results and
empty or non-string API keys/access tokens are rejected before adapter dispatch.

A numeric `size` is forwarded, not enforced by local resampling. Inspect decoded
original output dimensions to establish what was returned. In particular, a
request for `3840x2160` does not establish a 4K result. The historical Sol request
returned 1672x941; it must not be described as native 4K.

## Antigravity edits

The registered Flash image route forwards one validated original reference as
Gemini `inlineData` plus the prompt, selected native model, aspect ratio and
resolution tier in the existing Cloud Code envelope. Unsupported masks and URL
response format are rejected before submission. After submission, transport,
parsing, empty-image and upstream failures are terminal: no sibling model or
account request follows an ambiguous outcome.

[Gemini inline image documentation](https://ai.google.dev/gemini-api/docs/image-generation)
uses base64 original bytes and their MIME type. This contract is distinct from
account availability; see [MODEL-AVAILABILITY.md](MODEL-AVAILABILITY.md).

## Verification limits

Offline fixtures establish routing, original-byte preservation, negative guards,
option forwarding and terminal outcomes. They do not establish live entitlement,
image quality or actual native 4K. Hosted CI/build results must refer to the exact
repair commit. The existing gateway, owner credentials and private state are not
included in the fork or CI artifacts.
