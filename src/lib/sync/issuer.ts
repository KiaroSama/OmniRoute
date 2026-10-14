import { createErrorResponse } from "@/lib/api/errorResponse";
import { isTrustedLoopbackInternalServiceRequest } from "@/lib/api/internalServiceAuth";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { isCliTokenAuthValid } from "@/lib/middleware/cliTokenAuth";
import { AUTHZ_HEADER_AUTH_KIND, AUTHZ_HEADER_AUTH_LABEL } from "@/server/authz/headers";
import { isAuthRequired, isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";

/**
 * Who may issue a sync token.
 *
 * A sync token opens GET /api/sync/bundle, which returns decrypted provider credentials and
 * plaintext API keys. Every other surface keeps those away from machine credentials: GET
 * /api/providers masks them, /api/keys/{id}/reveal is off unless enabled, and /api/cloud/auth
 * gives a manage key only fragments. So issuing a sync token needs more than the `manage` scope:
 *
 *   - `session`  — the signed-in dashboard owner;
 *   - `cli`      — the machine-bound local CLI token (loopback only);
 *   - `internal` — the trusted loopback internal-service token;
 *   - `open`     — login is disabled on this instance, so every management route is open anyway.
 *
 * API keys (any scope) and remote CLI access tokens (`oma_…`) are refused: a manage key can mint
 * an `admin` access token, so accepting either would reopen the same path.
 */
export type SyncTokenIssuer = "session" | "cli" | "internal" | "open";

export type SyncTokenIssuerVerdict =
  { ok: true; issuer: SyncTokenIssuer } | { ok: false; response: Response };

export async function authorizeSyncTokenIssuer(request: Request): Promise<SyncTokenIssuerVerdict> {
  const authError = await requireManagementAuth(request);
  if (authError) return { ok: false, response: authError };

  if (!(await isAuthRequired(request, { ignorePublicRoute: true }))) {
    return { ok: true, issuer: "open" };
  }

  if (await isDashboardSessionAuthenticated(request)) {
    return { ok: true, issuer: "session" };
  }

  if (isTrustedLoopbackInternalServiceRequest(request)) {
    return { ok: true, issuer: "internal" };
  }

  if (
    (request.headers.get(AUTHZ_HEADER_AUTH_KIND) === "management_key" &&
      request.headers.get(AUTHZ_HEADER_AUTH_LABEL) === "local-cli-token") ||
    (await isCliTokenAuthValid(request))
  ) {
    return { ok: true, issuer: "cli" };
  }

  return {
    ok: false,
    response: createErrorResponse({
      status: 403,
      message:
        "Sync tokens can only be issued from a signed-in dashboard session or the local CLI.",
      type: "invalid_request",
    }),
  };
}
