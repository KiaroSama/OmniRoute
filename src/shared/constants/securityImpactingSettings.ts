/**
 * Settings keys whose change broadens attack surface. Spec §Security:
 * `PATCH /api/settings` requires password re-auth when any of these is present
 * in the body, and every other settings writer that skips that gate (e.g. the
 * legacy JSON import) MUST drop them instead of persisting them.
 *
 * - `localOnlyManageScopeBypassEnabled` / `localOnlyManageScopeBypassPrefixes`:
 *   T-011 bypass kill-switch + per-prefix list. Operator must re-confirm
 *   before broadening the LOCAL_ONLY carve-out.
 * - `requireLogin`: dashboard login enforcement toggle.
 * - `newPassword`: password rotation (existing). Handled by the same gate so
 *   the password-verify only fires ONCE per PATCH.
 * - `oidcEnabled` / `oidcDisablePasswordLogin` / `oidcClientSecret`: who may log
 *   in to the dashboard.
 *
 * Note: `mcpEnabled` is NOT gated server-side — the dedicated MCP page
 * (/dashboard/mcp) toggles it via patchSetting() without a currentPassword
 * prompt. The Authz section can still prompt client-side for consistency,
 * but the server accepts the change without re-auth.
 */
export const SECURITY_IMPACTING_SETTINGS_KEYS = [
  "localOnlyManageScopeBypassEnabled",
  "localOnlyManageScopeBypassPrefixes",
  "requireLogin",
  "newPassword",
  "oidcEnabled",
  "oidcDisablePasswordLogin",
  "oidcClientSecret",
] as const;
