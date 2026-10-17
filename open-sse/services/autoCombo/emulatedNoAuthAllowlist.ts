import { NOAUTH_PROVIDERS } from "@/shared/constants/providers";

type NoAuthCatalogEntry = (typeof NOAUTH_PROVIDERS)[keyof typeof NOAUTH_PROVIDERS];

/**
 * Auto-discover the no-auth (keyless) providers permitted to enter the
 * `auto`/`auto-*` candidate pool: every NOAUTH_PROVIDERS entry that opted into
 * prompt-emulated tool calling (`toolCalling: "emulated"` and `noAuth: true`).
 *
 * Those backends answer without any configuration, and their tool calls are
 * executed by the 3rd-party CLI (Claude Code, Codex, Cursor…) — the free
 * provider only emits the call markers, which the CLI parses and runs.
 *
 * Discovered from the catalog, so there is no hardcoded id list to maintain:
 * adding `toolCalling: "emulated"` to a NOAUTH_PROVIDERS entry admits it, and
 * removing the flag takes it back out. Providers without the flag stay fully
 * usable via direct `<alias>/<model>` calls — they are just not auto-routed to.
 *
 * On this catalog the set is `cloudflare-playground`, `devin-cli-agentic`,
 * `duckduckgo-web`, `opencode`, and `uncloseai`. `duckduckgo-web` and
 * `devin-cli-agentic` already carried `toolCalling: "emulated"`; `opencode`,
 * `cloudflare-playground`, and `uncloseai` opt in the same way. Providers
 * without the flag stay out (`aihorde`, `auggie`, `codex-app-server`,
 * `veoaifree-web`, `zcode`, and any other).
 *
 * History (operator decision 2026-07-24, refs #8183/#6453/#7032): the pool used
 * to be a hardcoded `{opencode}` allowlist aimed at public-HTTP-egress
 * reliability for category/tier and flat-variant `auto/*` pools, not
 * `auto/<family>` pools (`bypassAllowlist` in virtualFactory.ts). The owner
 * accepted expanding that pool to every no-auth provider with emulated tool
 * calling. `duckduckgo-web` is in the pool because it has the flag; `aihorde`
 * has no flag and stays out.
 */
function isEmulatedNoAuthProvider(
  providerDef: NoAuthCatalogEntry
): providerDef is NoAuthCatalogEntry & { id: string; toolCalling: "emulated" } {
  return (
    providerDef.noAuth === true &&
    "toolCalling" in providerDef &&
    providerDef.toolCalling === "emulated" &&
    typeof providerDef.id === "string" &&
    providerDef.id.length > 0
  );
}

/** Ids admitted to category/tier and flat-variant `auto/*` pools. */
export function getEmulatedToolCallingNoAuthProviders(): Set<string> {
  const emulated = new Set<string>();
  for (const providerDef of Object.values(NOAUTH_PROVIDERS)) {
    if (isEmulatedNoAuthProvider(providerDef)) emulated.add(providerDef.id);
  }
  return emulated;
}

/** Cached at module load; a catalog flag change is visible on the next process start. */
export const EMULATED_TOOL_CALLING_NOAUTH_PROVIDERS: ReadonlySet<string> =
  getEmulatedToolCallingNoAuthProviders();
