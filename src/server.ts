import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { privateTlsOptions } from "./tls.js";
import { TLSSocket } from "node:tls";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { requireMcpAuth } from "@better-auth/mcp";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { createMcpHandler, fromJsonSchema, McpServer, type Tool } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { createAuth, PEER_IP_HEADER } from "./auth.js";
import type { BridgeConfig } from "./config.js";
import type { State } from "./state.js";
import { Upstreams } from "./upstream.js";

const AUTH_BODY_LIMIT = 64 * 1024;
class AuthBodyTooLarge extends Error {}

async function readAuthBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Preserve the socket on overflow so the client receives 413 before Connection: close.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > AUTH_BODY_LIMIT) throw new AuthBodyTooLarge();
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks, bytes));
}

export function createBridge(config: BridgeConfig, db: State) {
  const tls = privateTlsOptions(config);
  const auth = createAuth(config, db);
  const upstreams = new Upstreams(config, db);
  const resource = `${config.publicUrl}/mcp`;

  function html(page: "sign-in" | "consent", detail = ""): Response {
    const title = page === "sign-in" ? "Identify yourself." : "Authorize uplink.";
    const fields = page === "sign-in" ? `<div class="fields"><label for="email"><span>01</span> Email address</label><input id="email" type="email" autocomplete="username" placeholder="owner@workspace" required><label for="password"><span>02</span> Password</label><input id="password" type="password" autocomplete="current-password" placeholder="Enter your password" required></div>` : "";
    const label = page === "sign-in" ? "Sign in" : "Allow access";
    const step = page === "sign-in" ? "OWNER AUTHENTICATION" : "CONNECTION CONSENT";
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark"><title>${page === "sign-in" ? "Sign in" : "Consent"} / T3 Bridge</title><link rel="stylesheet" href="/browser.css"></head><body data-page="${page}"><div class="city" aria-hidden="true"><div class="moon"></div><svg class="skyline" viewBox="0 0 1600 740" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="windows" width="22" height="25" patternUnits="userSpaceOnUse"><path d="M4 4h3v11H4z M13 4h3v11h-3z" fill="#6a376e"/><path d="M4 4h3v4H4z" fill="#e36fa8" opacity=".5"/></pattern><pattern id="slats" width="14" height="18" patternUnits="userSpaceOnUse"><path d="M0 4h9v2H0z" fill="#40bbcf" opacity=".45"/></pattern><linearGradient id="haze" x2="0" y2="1"><stop stop-color="#b52a8a" stop-opacity="0"/><stop offset="1" stop-color="#b52a8a" stop-opacity=".25"/></linearGradient></defs><path d="M0 410h60V280h55v35h35v-85h75v180h38V326h70v-96h48v155h75v-49h69v96h45V294h78v54h55V200h50v-52h20v52h42v210h57V312h62v80h62V241h80v-75h13v75h45v195h55V315h50v-60h80v155h50V188h77v-58h12v58h38v225h44V278h86v160h49V320h89v420H0z" fill="#171026"/><path d="M0 510h50V355h73V220h9v135h52v385H0z M220 740V420h40V170h24v-30h8v30h30v250h52v320z M390 740V490h50V380h95v360z M1110 740V390h61V282h95v458z M1300 740V338h44V109h58v-36h8v36h32v229h54v402z M1510 740V385h90v355z" fill="#110d20" stroke="#70305b" stroke-width="1"/><path d="M51 375h113v365H51z M272 190h38v550h-38z M451 399h65v341h-65z M1188 302h60v438h-60z M1357 130h72v610h-72z M1528 404h72v336h-72z" fill="url(#windows)"/><path d="M0 740V541h52v-40h50v239z M325 740V550h108v190z M1020 740V490h78v250z M1430 740V500h92v240z" fill="#0b0a17"/><path d="M0 550h100 M268 171h48 M1344 110h95 M1180 285h82" stroke="#fa4aaf" stroke-width="3"/><path d="M66 368v280 M318 438v140 M1256 324v230 M1436 345v225" stroke="#35dfdf" stroke-width="2"/><path d="M73 450h50v150H73z M1375 230h34v137h-34z" fill="#20203a" stroke="#44b4c7"/><path d="M84 467h27m-27 10h19m-19 24h27m-27 10h27m-27 24h19m-19 10h27m1268-296h16m-16 13h16m-16 23h16m-16 13h16m-16 23h16m-16 13h16" stroke="#60e2e7" stroke-width="3"/><path d="M0 175Q340 320 665 190M1100 180q250 100 500-20" fill="none" stroke="#38304c" stroke-width="3"/><path d="M0 430h1600v310H0z" fill="url(#haze)"/></svg><div class="rain"></div><div class="ground"></div></div><div class="shell"><header class="topbar"><div class="brand"><span class="brand-mark">T3<span>↗</span></span><span>BRIDGE<span class="brand-sub">PRIVATE ACCESS TERMINAL</span></span></div><span class="header-code">PERSONAL SYSTEMS <span>/</span> OWNER ACCESS</span></header><main class="terminal-layout"><aside class="sector" aria-hidden="true"><span class="sector-index">[ PRIVATE SECTOR ]</span><div class="sector-title">AFTER<br>HOURS<span>LAB ACCESS</span></div><div class="sector-rule"></div><p>AI SYSTEMS<br>CODE LABS<br>RESEARCH ARCHIVE</p><span class="sector-caption">THROUGH THE NOISE.<br>INTO THE WORK.</span></aside><section class="access-panel" aria-labelledby="access-title"><div class="panel-topline"><span><i aria-hidden="true"></i> T3.BRIDGE / AUTH</span><span aria-hidden="true">[ ${page === "sign-in" ? "01" : "02"} ]</span></div><div class="panel-content"><p class="panel-kicker">// ${step}</p><h1 id="access-title">${title}</h1><p class="detail">${detail}</p>${fields}<button id="action" type="button"><span>${label}</span><span class="button-arrow" aria-hidden="true">↗</span></button><p id="status" role="status" aria-live="polite"></p><div class="access-note"><span aria-hidden="true">◇</span><span>Your existing T3 permissions apply.</span></div></div><div class="panel-bottom" aria-hidden="true"><span>PRIVATE / PERSONAL</span><span class="barcode"></span><span>T3—AUTH</span></div></section><div class="side-label" aria-hidden="true">NEURAL INTERFACE <span>///</span> AI · CODE · LABS</div></main><footer class="page-footer"><span>T3 BRIDGE <span class="footer-divider">/</span> BROWSER AUTHORIZATION</span><span class="footer-signal" aria-hidden="true">▂ ▅ ▃ ▇ ▂ <span>END OF TRANSMISSION</span></span></footer></div><script type="module" src="/browser.js"></script></body></html>`;
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
  }

  function friendlyName(name: string, tool: Tool): string { return `${name}__${tool.name}`; }
  const mcpHandler = createMcpHandler(async () => {
    // The SDK default is process-wide and retains each freshly fetched schema.
    const inputValidator = new AjvJsonSchemaValidator();
    const server = new McpServer({ name: "t3-bridge", version: "0.1.0" });
    for (const upstream of config.upstreams) {
      for (const tool of await upstreams.list(upstream.name)) {
        server.registerTool(friendlyName(upstream.name, tool), {
          description: tool.description ?? `${upstream.name}: ${tool.name}`,
          inputSchema: fromJsonSchema(tool.inputSchema as Parameters<typeof fromJsonSchema>[0], inputValidator),
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
    if (path === "/sign-in" && request.method === "GET") return html("sign-in", "Use your owner account to continue.");
    if (path === "/consent" && request.method === "GET") {
      const { secret } = await auth.$context;
      if (!await verifyOAuthQueryParams(url.search.slice(1), secret)) return new Response("Invalid consent request", { status: 400 });
      const scopes = url.searchParams.get("scope") ?? "T3 tools";
      return html("consent", `Requested access: ${scopes.replace(/[&<>"']/g, "")}. Tools can read and change the connected T3 instances.`);
    }
    if (path === "/browser.js" && request.method === "GET") return new Response(readFileSync(new URL("../dist/browser.js", import.meta.url)), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
    if (path === "/browser.css" && request.method === "GET") return new Response(readFileSync(new URL("../dist/browser.css", import.meta.url)), { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" } });
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
      if (url.origin !== config.publicUrl || (req.headers.host !== new URL(config.publicUrl).host && (req.socket instanceof TLSSocket || req.headers.host !== `127.0.0.1:${config.listenPort}`))) {
        res.writeHead(400).end(); return;
      }
      const method = req.method ?? "GET";
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      // Forwarded IP claims are not authoritative, including on the private HTTPS listener.
      headers.delete(PEER_IP_HEADER);
      if (req.socket.remoteAddress) headers.set(PEER_IP_HEADER, req.socket.remoteAddress);
      const authPath = url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/");
      if (authPath && Number(req.headers["content-length"] ?? 0) > AUTH_BODY_LIMIT) throw new AuthBodyTooLarge();
      const body = method === "GET" || method === "HEAD" ? undefined
        : authPath ? await readAuthBody(req) : Readable.toWeb(req) as ReadableStream;
      const request = new Request(url, { method, headers, body, duplex: "half" } as RequestInit & { duplex: "half" });
      const response = await handle(request);
      const responseHeaders: Record<string, string | string[]> = Object.fromEntries(response.headers);
      const cookies = response.headers.getSetCookie();
      // Set-Cookie fields cannot be folded into one comma-separated header.
      if (cookies.length) responseHeaders["set-cookie"] = cookies;
      res.writeHead(response.status, responseHeaders);
      if (response.body) Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res);
      else res.end();
    } catch (error) {
      if (error instanceof AuthBodyTooLarge) {
        res.writeHead(413, { "content-type": "application/json", "cache-control": "no-store", connection: "close" })
          .end(JSON.stringify({ error: "payload_too_large", message: "Authentication request body exceeds 65536 bytes" }));
        return;
      }
      if (req.aborted) return;
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
