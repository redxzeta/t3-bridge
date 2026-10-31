import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getMigrations } from "better-auth/db/migration";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createAuth } from "./auth.js";
import { createBridge } from "./server.js";
import { openState, writeRecord } from "./state.js";
import { mockUpstream } from "./mock-upstream.test-helper.js";

async function fixture(upstreamUrl = "http://127.0.0.1:3773/mcp") {
  const root = mkdtempSync(join(tmpdir(), "t3-http-security-"));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); assert.ok(address && typeof address !== "string");
  const tlsPort = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const certFile = join(root, "server.crt"), keyFile = join(root, "server.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2", "-subj", "/CN=Synthetic bridge test", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
  const config = { publicUrl: `https://127.0.0.1:${tlsPort}`, listenPort: 0, privateHttps: { certFile, keyFile }, ownerEmail: "owner@example.com", upstreams: [{ name: "home", url: upstreamUrl }] };
  const previousSecret = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = "synthetic-http-security-".repeat(3);
  const db = openState(join(root, "state"));
  const initializer = createAuth(config, db, { setup: true });
  await (await getMigrations(initializer.options)).runMigrations();
  await initializer.api.signUpEmail({ body: { name: "Owner", email: config.ownerEmail, password: "synthetic-owner-password" } });
  const bridge = createBridge(config, db);
  await bridge.start();
  const httpAddress = bridge.server.address(); assert.ok(httpAddress && typeof httpAddress !== "string");
  config.listenPort = httpAddress.port;
  const call = (protocol: "http" | "https", body: string, headers: Record<string, string> = {}, chunked = false) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = `${protocol}://127.0.0.1:${protocol === "https" ? tlsPort : config.listenPort}/api/auth/sign-in/email`;
    const options: RequestOptions & { ca?: Buffer } = { method: "POST", agent: false, headers: { origin: config.publicUrl, "content-type": "application/json", ...headers }, ...(protocol === "https" ? { ca: readFileSync(certFile) } : {}) };
    const req = (protocol === "https" ? httpsRequest : httpRequest)(url, options, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: text }));
    });
    req.setTimeout(5000, () => req.destroy(new Error("Synthetic request timed out")));
    req.on("error", reject);
    if (chunked) { req.write(body.slice(0, 32768)); req.end(body.slice(32768)); }
    else req.end(body);
  });
  return { config, db, bridge, call, async close() {
    await bridge.close(); db.close();
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previousSecret;
    rmSync(root, { recursive: true });
  } };
}

test("HTTP and HTTPS login limits use the socket peer despite forged IP headers", async () => {
  for (const protocol of ["http", "https"] as const) {
    const f = await fixture();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        const claimedIp = `198.51.100.${i + 1}`;
        const response = await f.call(protocol, JSON.stringify({ email: f.config.ownerEmail, password: "synthetic-wrong-password" }), {
          "x-forwarded-for": claimedIp, "x-real-ip": claimedIp, "cf-connecting-ip": claimedIp, "x-t3-bridge-peer-ip": claimedIp,
        });
        statuses.push(response.status);
      }
      assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429], protocol);
    } finally { await f.close(); }
  }
});

test("HTTP and HTTPS auth bodies reject oversize declarations, chunks and UTF-8 bytes without auth side effects", async () => {
  for (const protocol of ["http", "https"] as const) {
    const f = await fixture();
    try {
      const limit = 64 * 1024;
      const sessionsBefore = (f.db.prepare('SELECT COUNT(*) AS n FROM "session"').get() as { n: number }).n;
      const base = { email: f.config.ownerEmail, password: "synthetic-owner-password", padding: "" };
      const baseBytes = Buffer.byteLength(JSON.stringify(base));
      const exact = JSON.stringify({ ...base, padding: "x".repeat(limit - baseBytes) });
      const utf8 = JSON.stringify({ ...base, padding: "é".repeat(Math.ceil((limit - baseBytes + 1) / 2)) });
      assert.equal(Buffer.byteLength(exact), limit);
      assert.ok(utf8.length < limit && Buffer.byteLength(utf8) > limit);
      for (let i = 0; i < 3; i++) {
        const response = await f.call(protocol, "", { "content-length": String(limit + 1) });
        assert.equal(response.status, 413); assert.equal(JSON.parse(response.body).error, "payload_too_large");
        assert.equal((await f.call(protocol, exact + " ", {}, true)).status, 413);
      }
      assert.equal((await f.call(protocol, utf8, {}, true)).status, 413);
      assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM "session"').get() as { n: number }).n, sessionsBefore);
      // Rejected uploads must not consume the five-attempt login bucket.
      assert.equal((await f.call(protocol, exact, {}, true)).status, 200);
    } finally { await f.close(); }
  }
});

test("an aborted authentication upload cannot create a session and does not break the listener", async () => {
  const f = await fixture();
  try {
    const sessionsBefore = (f.db.prepare('SELECT COUNT(*) AS n FROM "session"').get() as { n: number }).n;
    const aborted = new Promise<void>((resolve) => f.bridge.server.once("request", (req) => req.once("aborted", resolve)));
    const req = httpRequest(`http://127.0.0.1:${f.config.listenPort}/api/auth/sign-in/email`, { method: "POST", headers: { origin: f.config.publicUrl, "content-type": "application/json", "transfer-encoding": "chunked" } });
    req.on("error", () => {});
    req.write('{"email":"owner@example.com","password":');
    // Wait until the server is processing this upload, then close before a complete body exists.
    await new Promise<void>((resolve) => f.bridge.server.once("request", () => resolve()));
    req.destroy(); await aborted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM "session"').get() as { n: number }).n, sessionsBefore);
    assert.equal((await f.call("http", JSON.stringify({ email: f.config.ownerEmail, password: "synthetic-owner-password" }))).status, 200);
  } finally { await f.close(); }
});

test("the auth byte limit does not restrict larger authenticated MCP tool payloads", async () => {
  const home = await mockUpstream("home");
  const f = await fixture(home.url);
  const originalFetch = globalThis.fetch;
  const client = new Client({ name: "synthetic-large-payload-client", version: "0.0.0" });
  try {
    globalThis.fetch = async (input, init) => {
      const req = new Request(input, init);
      if (req.url === `${f.config.publicUrl}/api/auth/jwks`) return f.bridge.handle(req);
      return originalFetch(input, init);
    };
    writeRecord(f.db, "home", "tokens", { access_token: "home-access" });
    const { token } = await f.bridge.auth.api.signJWT({ body: { payload: { sub: "synthetic-owner", iss: `${f.config.publicUrl}/api/auth`, aud: `${f.config.publicUrl}/mcp`, scope: "mcp:tools" } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${f.config.listenPort}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const message = "m".repeat(80 * 1024);
    const result = await client.callTool({ name: "home__echo", arguments: { message } });
    assert.ok(result.content?.[0]?.type === "text" && result.content[0].text === `home:${message}`, "Larger MCP payload must keep working");
  } finally {
    await client.close(); globalThis.fetch = originalFetch; await f.close(); await home.close();
  }
});
