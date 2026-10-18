import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AuthProvider } from "@modelcontextprotocol/client";
import type { Tool } from "@modelcontextprotocol/server";
import type { BridgeConfig, UpstreamConfig } from "./config.js";
import { deleteRecord, readRecord, type State, writeRecord } from "./state.js";

type ClientRegistration = { client_id: string };
type UpstreamTokens = { access_token: string; refresh_token?: string; expires_at?: number };

function randomUrlSafe(): string { return randomBytes(32).toString("base64url"); }

export class Upstreams {
  private readonly clients = new Map<string, Client>();
  private readonly catalog = new Map<string, Tool[]>();
  private readonly refreshes = new Map<string, Promise<UpstreamTokens>>();
  constructor(private readonly config: BridgeConfig, private readonly db: State) {}

  private get(name: string): UpstreamConfig {
    const item = this.config.upstreams.find((value) => value.name === name);
    if (!item) throw new Error("Unknown upstream");
    return item;
  }

  private endpoint(name: string, path: string): URL {
    return new URL(path, this.get(name).url);
  }

  private async postJson(url: URL, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Upstream OAuth request failed (${response.status})`);
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid upstream OAuth response");
    return value as Record<string, unknown>;
  }

  private async postForm(url: URL, body: URLSearchParams): Promise<UpstreamTokens> {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body, redirect: "error", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Upstream token request failed (${response.status})`);
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid upstream token response");
    const token = value as Record<string, unknown>;
    if (typeof token.access_token !== "string" || !token.access_token) throw new Error("Upstream access token missing");
    if (token.refresh_token !== undefined && typeof token.refresh_token !== "string") throw new Error("Invalid upstream refresh token");
    if (token.expires_in !== undefined && (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in < 0)) throw new Error("Invalid upstream token lifetime");
    return {
      access_token: token.access_token,
      refresh_token: token.refresh_token as string | undefined,
      expires_at: typeof token.expires_in === "number" ? Date.now() + token.expires_in * 1000 : undefined,
    };
  }

  private async clientId(name: string): Promise<string> {
    const saved = readRecord<ClientRegistration>(this.db, name, "client");
    if (saved?.client_id) return saved.client_id;
    const registration = await this.postJson(this.endpoint(name, "/oauth/mcp/register"), {
      client_name: `T3 Bridge (${name})`,
      redirect_uris: [`${this.config.publicUrl}/upstream/callback/${name}`],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "orchestration:read orchestration:operate",
    });
    if (typeof registration.client_id !== "string" || !registration.client_id) throw new Error("Upstream client registration failed");
    writeRecord(this.db, name, "client", { client_id: registration.client_id });
    return registration.client_id;
  }

  private async refresh(name: string): Promise<UpstreamTokens> {
    const running = this.refreshes.get(name);
    if (running) return running;
    const task = (async () => {
      const old = readRecord<UpstreamTokens>(this.db, name, "tokens");
      if (!old?.refresh_token) throw new Error(`Upstream ${name} sign-in required`);
      const body = new URLSearchParams({
        grant_type: "refresh_token", refresh_token: old.refresh_token,
        client_id: await this.clientId(name), resource: this.get(name).url,
      });
      const fresh = await this.postForm(this.endpoint(name, "/oauth/mcp/token"), body);
      fresh.refresh_token ??= old.refresh_token;
      writeRecord(this.db, name, "tokens", fresh);
      return fresh;
    })();
    this.refreshes.set(name, task);
    try { return await task; } finally { this.refreshes.delete(name); }
  }

  private authProvider(name: string): AuthProvider {
    return {
      token: async () => {
        const tokens = readRecord<UpstreamTokens>(this.db, name, "tokens");
        if (!tokens) return undefined;
        if (tokens.expires_at !== undefined && tokens.expires_at <= Date.now() + 30000) return (await this.refresh(name)).access_token;
        return tokens.access_token;
      },
      onUnauthorized: async () => { await this.refresh(name); },
    };
  }

  private async connect(name: string): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const client = new Client({ name: "t3-bridge", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.get(name).url), { authProvider: this.authProvider(name) });
    await client.connect(transport);
    this.clients.set(name, client);
    return client;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((client) => client.close()));
    this.clients.clear();
  }

  async startAuthorization(name: string): Promise<URL> {
    const upstream = this.get(name);
    const clientId = await this.clientId(name);
    const state = randomUrlSafe();
    const verifier = randomUrlSafe();
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    writeRecord(this.db, name, "state", state);
    writeRecord(this.db, name, "verifier", verifier);
    deleteRecord(this.db, name, "tokens");
    this.clients.delete(name);
    const url = this.endpoint(name, "/oauth/mcp/authorize");
    url.search = new URLSearchParams({
      response_type: "code", client_id: clientId,
      redirect_uri: `${this.config.publicUrl}/upstream/callback/${name}`,
      code_challenge: challenge, code_challenge_method: "S256", state,
      scope: "orchestration:read orchestration:operate", resource: upstream.url,
    }).toString();
    return url;
  }

  async finishAuthorization(name: string, params: URLSearchParams): Promise<void> {
    const upstream = this.get(name);
    const state = readRecord<string>(this.db, name, "state");
    const verifier = readRecord<string>(this.db, name, "verifier");
    const code = params.get("code");
    if (!state || !verifier || !code || params.get("state") !== state || params.get("iss") !== new URL(upstream.url).origin) {
      throw new Error("Invalid upstream OAuth callback");
    }
    const tokens = await this.postForm(this.endpoint(name, "/oauth/mcp/token"), new URLSearchParams({
      grant_type: "authorization_code", code, code_verifier: verifier,
      redirect_uri: `${this.config.publicUrl}/upstream/callback/${name}`,
      client_id: await this.clientId(name), resource: upstream.url,
    }));
    writeRecord(this.db, name, "tokens", tokens);
    deleteRecord(this.db, name, "state");
    deleteRecord(this.db, name, "verifier");
    this.clients.delete(name);
    try { await this.connect(name); } catch { this.clients.delete(name); }
  }

  async list(name: string): Promise<Tool[]> {
    try {
      const client = await this.connect(name);
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      this.catalog.set(name, tools);
      return tools;
    } catch {
      this.clients.delete(name);
      return this.catalog.get(name) ?? [];
    }
  }

  async call(name: string, tool: string, args: Record<string, unknown>) {
    try { return await (await this.connect(name)).callTool({ name: tool, arguments: args }); }
    catch (error) {
      this.clients.delete(name);
      return { isError: true, content: [{ type: "text" as const, text: `Upstream ${name} unavailable: ${error instanceof Error ? error.message : "connection failed"}` }] };
    }
  }
}
