import { isCliTokenAuthValid } from "@/lib/middleware/cliTokenAuth";
import { AUTHZ_HEADER_AUTH_KIND, AUTHZ_HEADER_AUTH_LABEL } from "@/server/authz/headers";
import { isAuthRequired, isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";

export type OperatorCredentialKind = "open_instance" | "dashboard_session" | "local_cli";

/**
 * Is the caller the instance operator, as opposed to a machine credential?
 *
 * Operator credentials are the ones only the owner of the instance holds:
 *   - an instance with login disabled (every management surface is already open),
 *   - an authenticated dashboard session (password / OIDC login),
 *   - the machine-bound local CLI credential — the subject stamped by the authz pipeline,
 *     or validated here (loopback-only) for raw callers that skip the pipeline.
 *
 * API keys (whatever their scope) and `oma_` access tokens are machine credentials: they
 * can be handed to automation, so actions that hand out top-level privilege must not be
 * reachable with them alone. Returns `null` when the caller is not an operator.
 *
 * Throws when the auth backend fails — callers map that to a 503, never to an allow.
 */
export async function resolveOperatorCredential(
  request: Request
): Promise<OperatorCredentialKind | null> {
  if (!(await isAuthRequired(request, { ignorePublicRoute: true }))) return "open_instance";
  if (await isDashboardSessionAuthenticated(request)) return "dashboard_session";
  if (
    request.headers.get(AUTHZ_HEADER_AUTH_KIND) === "management_key" &&
    request.headers.get(AUTHZ_HEADER_AUTH_LABEL) === "local-cli-token"
  ) {
    return "local_cli";
  }
  if (await isCliTokenAuthValid(request)) return "local_cli";
  return null;
}
