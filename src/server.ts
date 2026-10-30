import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { privateTlsOptions } from "./tls.js";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { requireMcpAuth } from "@better-auth/mcp";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { createMcpHandler, fromJsonSchema, McpServer, type Tool } from "@modelcontextprotocol/server";
import { createAuth } from "./auth.js";
import type { BridgeConfig } from "./config.js";
import type { State } from "./state.js";
import { Upstreams } from "./upstream.js";

export function createBridge(config: BridgeConfig, db: State) {
  const tls = privateTlsOptions(config);
  const auth = createAuth(config, db);
  const upstreams = new Upstreams(config, db);
  const resource = `${config.publicUrl}/mcp`;

  function html(page: "sign-in" | "consent", detail = ""): Response {
    const title = page === "sign-in" ? "Sign in to T3 Bridge" : "Allow access to T3 Bridge";
    const fields = page === "sign-in" ? '<label>Email <input id="email" type="email" autocomplete="username" required></label><label>Password <input id="password" type="password" autocomplete="current-password" required></label>' : "";
    const label = page === "sign-in" ? "Sign in" : "Allow access";
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body data-page="${page}"><main><h1>${title}</h1><p>${detail}</p>${fields}<button id="action">${label}</button><p id="status" role="status"></p></main><script type="module" src="/browser.js"></script></body></html>`;
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
  }

  function friendlyName(name: string, tool: Tool): string { return `${name}__${tool.name}`; }
  const mcpHandler = createMcpHandler(async () => {
    const server = new McpServer({ name: "t3-bridge", version: "0.1.0" });
    for (const upstream of config.upstreams) {
      for (const tool of await upstreams.list(upstream.name)) {
        server.registerTool(friendlyName(upstream.name, tool), {
          description: tool.description ?? `${upstream.name}: ${tool.name}`,
          inputSchema: fromJsonSchema(tool.inputSchema as Parameters<typeof fromJsonSchema>[0]),
          annotations: tool.annotations,
        }, async (args) => upstreams.call(upstream.name, tool.name, args as Record<string, unknown>));
      }
    }
    return server;
  }, { legacy: "stateless" });

  const protectedMcp = requireMcpAuth(auth, (request) => mcpHandler.fetch(request), {
    resource, requiredScopes: ["mcp:tools"], jwksUrl: `${config.publicUrl}/api/auth/jwks`,
  });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/mcp") return request.method === "POST" ? protectedMcp(request) : new Response("Method not allowed", { status: 405 });
    if (path === "/sign-in" && request.method === "GET") return html("sign-in", "Use the owner account created during setup.");
    if (path === "/consent" && request.method === "GET") {
      const { secret } = await auth.$context;
      if (!await verifyOAuthQueryParams(url.search.slice(1), secret)) return new Response("Invalid consent request", { status: 400 });
      const scopes = url.searchParams.get("scope") ?? "T3 tools";
      return html("consent", `Requested access: ${scopes.replace(/[&<>"']/g, "")}. Tools can read and change the connected T3 instances.`);
    }
    if (path === "/browser.js" && request.method === "GET") return new Response(readFileSync(new URL("../dist/browser.js", import.meta.url)), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
    const callback = /^\/upstream\/callback\/([a-z][a-z0-9_]{0,30})$/.exec(path);
    if (callback && request.method === "GET") {
      try { await upstreams.finishAuthorization(callback[1]!, url.searchParams); return html("sign-in", `Connected ${callback[1]}. You can close this page.`); }
      catch { return new Response("Upstream authorization failed", { status: 400 }); }
    }
    if (path.startsWith("/api/auth/") || path === "/api/auth" || path.startsWith("/.well-known/")) return auth.handler(request);
    return new Response("Not found", { status: 404 });
  }

  async function nodeRequest(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? "/", config.publicUrl);
      if (url.origin !== config.publicUrl || (req.headers.host !== new URL(config.publicUrl).host && req.headers.host !== `127.0.0.1:${config.listenPort}`)) {
        res.writeHead(400).end(); return;
      }
      const method = req.method ?? "GET";
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const request = new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(req) as ReadableStream, duplex: "half" } as RequestInit & { duplex: "half" });
      const response = await handle(request);
      const responseHeaders: Record<string, string | string[]> = Object.fromEntries(response.headers);
      const cookies = response.headers.getSetCookie();
      // Set-Cookie fields cannot be folded into one comma-separated header.
      if (cookies.length) responseHeaders["set-cookie"] = cookies;
      res.writeHead(response.status, responseHeaders);
      if (response.body) Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res);
      else res.end();
    } catch (error) {
      console.error("Request failed");
      if (!res.headersSent) res.writeHead(500).end("Internal error"); else res.end();
    }
  }

  const server = createServer(nodeRequest);
  const httpsServer = tls ? createHttpsServer(tls, nodeRequest) : undefined;
  const listeners: Server[] = httpsServer ? [server, httpsServer] : [server];
  const closeListeners = () => Promise.all(listeners.map((listener) => new Promise<void>((resolve) => {
    if (!listener.listening) { resolve(); return; }
    listener.close(() => resolve());
    listener.closeIdleConnections();
  })));
  async function close() {
    await closeListeners();
    await upstreams.close();
  }
  async function start() {
    const listen = (listener: Server, port: number, host: string) => new Promise<void>((resolve, reject) => {
      const error = (cause: Error) => reject(cause);
      listener.once("error", error);
      listener.listen(port, host, () => { listener.off("error", error); resolve(); });
    });
    try {
      await listen(server, config.listenPort, "127.0.0.1");
      if (httpsServer) {
        const origin = new URL(config.publicUrl);
        await listen(httpsServer, Number(origin.port || 443), origin.hostname);
      }
    } catch {
      await close();
      throw new Error("T3 Bridge could not bind its configured listeners");
    }
  }
  return { auth, upstreams, handle, server, httpsServer, start, close };

}
