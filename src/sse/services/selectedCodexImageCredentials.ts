import { checkAndRefreshToken } from "./tokenRefresh";
import { getRefreshLeadMs } from "@omniroute/open-sse/services/tokenRefresh.ts";
import { isAllRateLimitedCredentials } from "@/app/api/v1/_shared/rateLimit";
import { isCodexFreePlan } from "@omniroute/open-sse/config/codexPlan.ts";

export type SelectedCodexImageCredentials = {
  accessToken?: string;
  apiKey?: string;
  refreshToken?: string;
  expiresAt?: string;
  connectionId?: string;
  providerSpecificData?: Record<string, unknown>;
};
function isSelectedCredentials(value: object): value is SelectedCodexImageCredentials {
  return "accessToken" in value && typeof value.accessToken === "string" &&
    (!("expiresAt" in value) || value.expiresAt === null || typeof value.expiresAt === "string") &&
    (!("connectionId" in value) || typeof value.connectionId === "string") &&
    (!("providerSpecificData" in value) || value.providerSpecificData === null || (typeof value.providerSpecificData === "object" && !Array.isArray(value.providerSpecificData)));
}
type SelectedResult =
  | { success: true; credentials: SelectedCodexImageCredentials }
  | { success: false; status: number; error: string; retryable: false };

/** Refresh the selected image account once; never select, rotate or retry another account. */
export async function refreshSelectedCodexImageCredentials(
  credentials: unknown,
  signal?: AbortSignal | null
): Promise<SelectedResult> {
  const fail = (status: number, error: string): SelectedResult => ({ success: false, status, error, retryable: false });
  if (signal?.aborted) return fail(499, "Codex Images request cancelled before submission");
  if (!credentials || typeof credentials !== "object" || "allExpired" in credentials) return fail(401, "No usable selected Codex account credentials");
  if ("blockedByKeyPolicy" in credentials) return fail(403, "Selected image connection is not allowed by API key policy");
  if (isAllRateLimitedCredentials(credentials) || "allRateLimited" in credentials) return fail(429, "Selected Codex account is unavailable");
  if (!isSelectedCredentials(credentials)) return fail(401, "No usable selected Codex account credentials");
  if (isCodexFreePlan(credentials.providerSpecificData)) return fail(403, "Codex Images requires a paid ChatGPT/Codex plan");
  try {
    const originalExpiry = credentials.expiresAt ? Date.parse(credentials.expiresAt) : null;
    const refreshDue = originalExpiry !== null && originalExpiry - Date.now() < getRefreshLeadMs("codex", credentials.providerSpecificData);
    const selected = await checkAndRefreshToken("codex", credentials);
    const expiry = selected.expiresAt ? Date.parse(selected.expiresAt) : null;
    const refreshFailed = refreshDue && selected.accessToken === credentials.accessToken && selected.expiresAt === credentials.expiresAt;
    if (!selected.accessToken || refreshFailed || (expiry !== null && (!Number.isFinite(expiry) || expiry <= Date.now()))) {
      return fail(401, "Selected Codex account refresh failed; reconnect that account");
    }
    if (selected.connectionId !== credentials.connectionId || selected.providerSpecificData?.workspaceId !== credentials.providerSpecificData?.workspaceId) return fail(401, "Selected Codex account changed during refresh; submission refused");
    if (signal?.aborted) return fail(499, "Codex Images request cancelled before submission");
    return { success: true, credentials: selected };
  } catch {
    return fail(401, "Selected Codex account refresh failed; reconnect that account");
  }
}
