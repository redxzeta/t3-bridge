import { createServer } from "node:http";
import { createHash } from "node:crypto";

// Disposable protocol fixture: never contacts a configured T3 installation.
export async function mockUpstream(name: string) {
  const calls: unknown[] = [];
  const fixture = { callGate: undefined as ((args: Record<string, unknown>) => Promise<void>) | undefined, dropMessage: undefined as string | undefined, initializes: 0, initializeGate: undefined as Promise<void> | undefined, onInitialize: undefined as (() => void) | undefined, challenge: "", refreshFails: false, permissionDenied: false, registrations: 0, exchanges: 0, refreshes: 0, dropResponse: false, exchangeGate: undefined as Promise<void> | undefined, refreshGate: undefined as Promise<void> | undefined, onExchange: undefined as (() => void) | undefined, onRefresh: undefined as (() => void) | undefined };
  const server = createServer(async (req, res) => {
    const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.url === "/oauth/mcp/register") {
      fixture.registrations++;
      return void json(201, { client_id: `${name}-client-${fixture.registrations}` });
    }
    if (req.url === "/oauth/mcp/token") {
      const body = new URLSearchParams(text);
      if (body.get("grant_type") === "refresh_token") {
        fixture.refreshes++;
        fixture.onRefresh?.();
        await fixture.refreshGate;
        if (fixture.refreshFails) return void json(400, { error: "invalid_grant" });
        return void json(200, { access_token: `${name}-fresh`, expires_in: 3600 });
      }
      fixture.exchanges++;
      fixture.onExchange?.();
      await fixture.exchangeGate;
      const actual = createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
      if (!fixture.challenge || fixture.challenge !== actual || body.get("code") !== "synthetic-code") return void json(400, { error: "invalid_grant" });
      return void json(200, { access_token: `${name}-access`, refresh_token: `${name}-refresh`, expires_in: 3600 });
    }
    if (req.url !== "/mcp") return void json(404, {});
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    if (![`${name}-access`, `${name}-fresh`].some((token) => req.headers.authorization === `Bearer ${token}`)) return void json(401, {});
    const body = JSON.parse(text);
    if (body.id === undefined) { res.writeHead(202).end(); return; }
    let result: unknown = {};
    if (body.method === "initialize") { fixture.initializes++; fixture.onInitialize?.(); await fixture.initializeGate; }
    if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version: "0.0.0" } };
    if (body.method === "tools/list") result = { tools: [{ name: "echo", description: "Synthetic echo", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] }, annotations: { readOnlyHint: true } }] };
    if (body.method === "tools/call") {
      calls.push(body.params);
      await fixture.callGate?.(body.params.arguments);
      if (fixture.dropResponse || body.params.arguments.message === fixture.dropMessage) { req.socket.destroy(); return; }
      result = fixture.permissionDenied ? { isError: true, content: [{ type: "text", text: "T3 approval required" }] } : { content: [{ type: "text", text: `${name}:${body.params.arguments.message}` }] };
    }
    json(200, { jsonrpc: "2.0", id: body.id, result });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No mock port");
  return { fixture, calls, url: `http://127.0.0.1:${address.port}/mcp`, close: () => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
