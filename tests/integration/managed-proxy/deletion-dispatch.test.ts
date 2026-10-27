import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { build } from "esbuild";
import { assertManagedFixture } from "../../_setup/managedProxyFixture.mjs";

const sandbox = assertManagedFixture();
const project = process.cwd();

// Next routes the HTTP requests itself. Only state, credentials and native lifecycle are fake.
const adapters: Record<string, string> = {
  "src/lib/db/readCache": "export async function getCachedSettings(){return {};}",
  "src/lib/gracefulShutdown": "export function isDraining(){return false;}",
  "src/lib/config/runtimeSettings":
    "export function getAuthzBypassSnapshot(){return {enabled:false,prefixes:[]};}",
  "src/shared/utils/apiAuth": `
    export async function isAuthRequired(){return true;}
    export async function isDashboardSessionAuthenticated(){return false;}`,
  "src/lib/machineToken": `
    export function getMachineTokenSync(){return "synthetic-cli-token";}
    export function getLegacyCliTokenSync(){return "";}`,
  "src/shared/services/modelSyncScheduler":
    "export function isModelSyncInternalRequest(){return false;}",
  "src/lib/db/apiKeys": `
    export async function getApiKeyMetadata(){return {id:"fixture",scopes:["manage"]};}
    export async function validateApiKey(key){return key==="synthetic-management-key";}`,
  "src/sse/services/auth": `
    export function extractApiKey(request){return request.headers.get("authorization")?.slice(7)||null;}
    export async function isValidApiKey(key){return key==="synthetic-management-key";}
    export function readNonEmptyUrlToken(){return null;}`,
  "src/lib/db/accessTokens": `
    export function verifyAccessToken(token){return token==="oma_fixture_write"
      ? {id:"fixture",name:"fixture",scope:"write"}:null;}`,
  "src/lib/api/internalServiceAuth": `
    export function isInternalServiceRequest(){return false;}
    export function isTrustedLoopbackInternalServiceRequest(){return false;}`,
  "src/lib/middleware/cliTokenAuth": "export async function isCliTokenAuthValid(){return false;}",
  "open-sse/services/ipFilter": "export function checkRequestIP(){return {allowed:true};}",
  "src/shared/utils/featureFlags": "export function isRequireApiKeyEnabled(){return true;}",
  "open-sse/utils/proxyDispatcher": "export function clearDispatcherCache(){}",
  "src/lib/db/proxies": `
    export async function getProxyById(id){return id==="missing"?null:{id,notes:
      id.startsWith("managed")?JSON.stringify({managedProxyId:id,managedCore:"singbox"}):null};}
    export async function deleteProxyById(id){return id!=="missing";}`,
  "src/lib/services/managedProxy/remove": `
    export async function removeManagedProxy(core,id,commit){
      if(core!=="singbox"||!id.startsWith("managed"))throw new Error("Invalid fixture removal");
      return commit();
    }`,
};

for (const basePath of ["", "/omniroute"]) {
  test(
    `actual Next HTTP preserves deletion contracts with basePath '${basePath}'`,
    { timeout: 90000 },
    async () => {
      const root = fs.mkdtempSync(path.join(sandbox, "next-delete-"));
      const bundle = path.join(root, "deletion.cjs");
      let app: ReturnType<typeof import("next").default> | undefined;
      let server: ReturnType<typeof createServer> | undefined;
      const previousMode = process.env.NODE_ENV;
      const previousToken = process.env.OMNIROUTE_PEER_STAMP_TOKEN;
      const previousTelemetry = process.env.NEXT_TELEMETRY_DISABLED;
      process.env.NEXT_TELEMETRY_DISABLED = "1";
      try {
        await build({
          stdin: {
            contents: `
            export {runAuthzPipeline} from "./src/server/authz/pipeline";
            export {DELETE,POST} from "./src/app/api/services/managed-proxy/registry-delete/route";
            export {handleProxyDelete} from "./src/lib/api/proxyDeletionHandlers";
            export {POST as batchDelete} from "./src/app/api/settings/proxies/batch-delete/route";`,
            resolveDir: project,
          },
          outfile: bundle,
          bundle: true,
          platform: "node",
          format: "cjs",
          packages: "external",
          tsconfig: path.join(project, "tsconfig.json"),
          plugins: [
            {
              name: "isolated-managed-state",
              setup(builder) {
                builder.onResolve({ filter: /.*/ }, (args) => {
                  let resolved: string | undefined;
                  if (args.path.startsWith("@/")) resolved = `src/${args.path.slice(2)}`;
                  else if (args.path.startsWith("@omniroute/open-sse/"))
                    resolved = `open-sse/${args.path.slice("@omniroute/open-sse/".length)}`;
                  else if (args.path.startsWith("."))
                    resolved = path
                      .relative(project, path.resolve(args.resolveDir, args.path))
                      .replaceAll("\\", "/");
                  const key = resolved?.replace(/\.(?:ts|tsx)$/, "");
                  if (key === "open-sse/utils/error")
                    return { path: path.join(project, "open-sse/utils/errorSanitization.ts") };
                  return key && key in adapters ? { path: key, namespace: "fixture" } : undefined;
                });
                builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
                  contents: adapters[args.path],
                  loader: "js",
                }));
              },
            },
          ],
        });
        const write = (name: string, text: string) => {
          const target = path.join(root, name);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, text, "utf8");
        };
        write("package.json", JSON.stringify({ private: true }));
        write(
          "next.config.js",
          `module.exports={basePath:${JSON.stringify(basePath)},devIndicators:false};`
        );
        write("app/layout.js", "export default function Layout({children}){return children;}");
        write(
          "proxy.js",
          'import d from "./deletion.cjs"; export function proxy(r){return d.runAuthzPipeline(r,{enforce:true});} export const config={matcher:["/api/:path*"]};'
        );
        write(
          "app/api/services/managed-proxy/registry-delete/route.js",
          'import d from "../../../../../deletion.cjs"; export const DELETE=d.DELETE; export const POST=d.POST;'
        );
        write(
          "app/api/settings/proxies/route.js",
          'import d from "../../../../deletion.cjs"; export const DELETE=d.handleProxyDelete;'
        );
        write(
          "app/api/settings/proxies/batch-delete/route.js",
          'import d from "../../../../../deletion.cjs"; export const POST=d.batchDelete;'
        );
        write(
          "app/api/v1/management/proxies/route.js",
          'import d from "../../../../../deletion.cjs"; export const DELETE=d.handleProxyDelete;'
        );
        Object.assign(process.env, { NODE_ENV: "development" });
        process.env.OMNIROUTE_PEER_STAMP_TOKEN = "synthetic-http-peer";
        const next = (await import("next")).default;
        app = next({ dir: root, dev: true, webpack: true, hostname: "127.0.0.1" });
        await app.prepare();
        const handler = app.getRequestHandler();
        const { wrapRequestListenerWithPeerStamp } =
          await import("../../../scripts/dev/peer-stamp.mjs");
        server = createServer(
          wrapRequestListenerWithPeerStamp((req, res) => {
            void handler(req, res).catch(() => {
              res.statusCode = 500;
              res.end("Fixture handler failed");
            });
          })
        );
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}${basePath}`;
        const send = (pathname: string, init: RequestInit = {}) =>
          fetch(`${origin}${pathname}`, {
            ...init,
            redirect: "manual",
            signal: AbortSignal.timeout(20000),
            headers: { authorization: "Bearer oma_fixture_write", ...init.headers },
          });
        for (const pathname of ["/api/settings/proxies", "/api/v1/management/proxies"]) {
          const response = await send(`${pathname}?id=managed-first&force=1`, {
            method: "DELETE",
            // The v1 path retains its existing client-API key policy.
            ...(pathname.includes("/v1/")
              ? { headers: { authorization: "Bearer synthetic-management-key" } }
              : {}),
          });
          assert.equal(response.status, 200, await response.clone().text());
          assert.equal(response.headers.get("location"), null);
          assert.equal(response.headers.get("x-omniroute-proxy-delete-origin"), null);
          assert.deepEqual(await response.json(), { success: true });
        }
        const cli = await send("/api/settings/proxies?id=managed-cli", {
          method: "DELETE",
          headers: { authorization: "", "x-omniroute-cli-token": "synthetic-cli-token" },
        });
        assert.equal(cli.status, 200, await cli.clone().text());
        const batch = await send("/api/settings/proxies/batch-delete", {
          method: "POST",
          body: JSON.stringify({ ids: ["ordinary", "missing", "managed-batch"], force: true }),
        });
        assert.equal(batch.status, 200, await batch.clone().text());
        assert.deepEqual(await batch.json(), {
          success: true,
          deleted: 2,
          failed: 1,
          results: [
            { id: "ordinary", success: true },
            { id: "missing", success: false, error: "Proxy not found" },
            { id: "managed-batch", success: true },
          ],
        });
        const spoof = await send("/api/services/managed-proxy/registry-delete?id=managed-first", {
          method: "DELETE",
          headers: {
            authorization: "Bearer synthetic-management-key",
            "x-omniroute-proxy-delete-origin": "/api/settings/proxies",
            "x-omniroute-peer-locality": "loopback",
          },
        });
        assert.equal(spoof.status, 403, await spoof.clone().text());
        const remoteOrdinary = await send("/api/settings/proxies?id=ordinary", {
          method: "DELETE",
          headers: { "x-forwarded-for": "203.0.113.10" },
        });
        assert.equal(remoteOrdinary.status, 200, await remoteOrdinary.clone().text());
        const remoteManaged = await send("/api/settings/proxies?id=managed-first", {
          method: "DELETE",
          headers: { "x-forwarded-for": "203.0.113.10" },
        });
        assert.equal(remoteManaged.status, 500);
      } finally {
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            server!.close((error) => (error ? reject(error) : resolve()))
          );
        }
        await app?.close();
        if (previousMode === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
        else Object.assign(process.env, { NODE_ENV: previousMode });
        if (previousToken === undefined) delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
        else process.env.OMNIROUTE_PEER_STAMP_TOKEN = previousToken;
        if (previousTelemetry === undefined) delete process.env.NEXT_TELEMETRY_DISABLED;
        else process.env.NEXT_TELEMETRY_DISABLED = previousTelemetry;
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );
}
