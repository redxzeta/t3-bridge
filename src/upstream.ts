import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport, UnauthorizedError, SdkHttpError } from "@modelcontextprotocol/client";
import type { AuthProvider } from "@modelcontextprotocol/client";
import type { Tool } from "@modelcontextprotocol/server";
import type { BridgeConfig, UpstreamConfig } from "./config.js";
import { deleteRecord, readRecord, type State, writeRecord } from "./state.js";

type ClientRegistration = { client_id: string; redirect_uri?: string };
type PendingAuthorization = { client: ClientRegistration; redirectUri: string; state: string; verifier: string };
type Connection = { client: Client; ready: Promise<Client>; users: number; connected?: boolean; controller: AbortController; closing?: Promise<void> };
type UpstreamTokens = { access_token: string; refresh_token?: string; expires_at?: number };

export type DiagnosticResult = {
  name: string;
  status: "ok" | "sign_in_required" | "unavailable" | "error";
  toolCount?: number;
  reason?: string;
};

export const DISCOVERY_BUDGET_MS = 5000;
export const CATALOG_FRESH_MS = 30000;

type Observation = {
  outcome: DiagnosticResult["status"];
  observedAt: string;
  lastSuccessAt: string | null;
  cached: boolean;
  fallback: boolean;
  reason?: string;
};
export type UpstreamStatus = {
  name: string;
  status: "unknown" | "fresh" | "stale" | "sign_in_required" | "unavailable" | "error";
  connection: "unknown" | "initialized" | "not_initialized";
  discovery: "unknown" | DiagnosticResult["status"];
  observedAt: string | null;
  lastSuccessAt: string | null;
  catalog: { count: number | null; freshness: "unknown" | "fresh" | "stale"; cached: boolean; fallback: boolean };
  failure: { category: string; reason: string; action: string } | null;
};
type Discovery = { controller: AbortController; promise: Promise<Tool[]> };

async function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

class UpstreamFailure extends Error {
  constructor(readonly status: Exclude<DiagnosticResult["status"], "ok">, message: string) { super(message); }
}

function failure(error: unknown): { status: Exclude<DiagnosticResult["status"], "ok">; reason: string } {
  if (error instanceof UpstreamFailure) return { status: error.status, reason: error.message };
  if (error instanceof UnauthorizedError || (error instanceof SdkHttpError && error.status === 401)) {
    return { status: "sign_in_required", reason: "Upstream authorization rejected" };
  }
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
    return { status: "unavailable", reason: "Upstream check cancelled or timed out" };
  }
  if (error instanceof TypeError || error instanceof SdkHttpError) return { status: "unavailable", reason: "Upstream network or HTTP request failed" };
  return { status: "error", reason: "Upstream request failed" };
}

function randomUrlSafe(): string { return randomBytes(32).toString("base64url"); }

export class Upstreams {
  private readonly exchanges = new Set<string>();
  private readonly clients = new Map<string, Connection>();
  private readonly retired = new Set<Connection>();
  private readonly catalog = new Map<string, Tool[]>();
  private readonly observations = new Map<string, Observation>();
  private readonly discoveries = new Map<string, Discovery>();
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

  private async postForm(url: URL, body: URLSearchParams, signal?: AbortSignal): Promise<UpstreamTokens> {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new UpstreamFailure(
      response.status === 400 || response.status === 401 ? "sign_in_required" : "unavailable",
      `Upstream token request failed (${response.status})`,
    );
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

  private clientId(name: string): string {
    const saved = readRecord<ClientRegistration>(this.db, name, "client");
    if (!saved?.client_id) throw new UpstreamFailure("sign_in_required", "Upstream OAuth client missing");
    return saved.client_id;
  }

  private async registration(name: string, redirectUri: string): Promise<ClientRegistration> {
    const pending = readRecord<PendingAuthorization>(this.db, name, "pending");
    if (pending?.redirectUri === redirectUri) return pending.client;
    const saved = readRecord<ClientRegistration>(this.db, name, "client");
    if (saved?.redirect_uri === redirectUri) return saved;
    const registration = await this.postJson(this.endpoint(name, "/oauth/mcp/register"), {
      client_name: `T3 Bridge (${name})`, redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], scope: "orchestration:read orchestration:operate",
    });
    if (typeof registration.client_id !== "string" || !registration.client_id) throw new Error("Upstream client registration failed");
    return { client_id: registration.client_id, redirect_uri: redirectUri };
  }

  private async refresh(name: string, signal: AbortSignal): Promise<UpstreamTokens> {
    signal.throwIfAborted();
    const running = this.refreshes.get(name);
    if (running) return running;
    const task = (async () => {
      const old = readRecord<UpstreamTokens>(this.db, name, "tokens");
      if (!old?.refresh_token) throw new UpstreamFailure("sign_in_required", "Upstream sign-in required");
      const clientId = this.clientId(name);
      const body = new URLSearchParams({
        grant_type: "refresh_token", refresh_token: old.refresh_token,
        client_id: clientId, resource: this.get(name).url,
      });
      const fresh = await this.postForm(this.endpoint(name, "/oauth/mcp/token"), body, signal);
      signal.throwIfAborted();
      const current = readRecord<UpstreamTokens>(this.db, name, "tokens");
      if (this.clientId(name) !== clientId || current?.access_token !== old.access_token || current?.refresh_token !== old.refresh_token) {
        throw new Error("Upstream authorization changed during refresh");
      }
      fresh.refresh_token ??= old.refresh_token;
      writeRecord(this.db, name, "tokens", fresh);
      return fresh;
    })();
    this.refreshes.set(name, task);
    try { return await task; } finally { if (this.refreshes.get(name) === task) this.refreshes.delete(name); }
  }

  private authProvider(name: string, signal: AbortSignal): AuthProvider {
    return {
      token: async () => {
        signal.throwIfAborted();
        const tokens = readRecord<UpstreamTokens>(this.db, name, "tokens");
        if (!tokens) return undefined;
        if (tokens.expires_at !== undefined && tokens.expires_at <= Date.now() + 30000) return (await this.refresh(name, signal)).access_token;
        return tokens.access_token;
      },
      onUnauthorized: async () => { await this.refresh(name, signal); },
    };
  }

  private connect(name: string): Connection {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const client = new Client({ name: "t3-bridge", version: "0.1.0" });
    const controller = new AbortController();
    // Publish ownership before initialization so cold concurrent requests share a client.
    const connection: Connection = { client, controller, users: 0, ready: Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted();
        const transport = new StreamableHTTPClientTransport(new URL(this.get(name).url), {
          authProvider: this.authProvider(name, controller.signal),
          fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) }),
        });
        await client.connect(transport, { signal: controller.signal });
        controller.signal.throwIfAborted();
        if (this.clients.get(name) !== connection) throw new Error("Upstream connection superseded");
        connection.connected = true;
        return client;
      } catch (error) {
        await this.closeConnection(connection, error);
        if (this.clients.get(name) === connection) this.clients.delete(name);
        throw error;
      }
    }) };
    this.clients.set(name, connection);
    return connection;
  }

  private discard(name: string, connection: Connection): void {
    // A late error from an old client must not evict its replacement.
    if (this.clients.get(name) === connection) this.clients.delete(name);
    this.retired.add(connection);
  }

  private async release(name: string, connection: Connection): Promise<void> {
    connection.users--;
    // Retire failed clients only after other in-flight operations have completed.
    if (connection.users === 0 && this.clients.get(name) !== connection) {
      await this.closeConnection(connection);
      this.retired.delete(connection);
    }
  }

  private closeConnection(connection: Connection, reason?: unknown): Promise<void> {
    connection.connected = false;
    connection.controller.abort(reason);
    connection.closing ??= connection.client.close().catch(() => {});
    return connection.closing;
  }

  async close(): Promise<void> {
    const discoveries = [...this.discoveries.values()];
    this.discoveries.clear();
    for (const discovery of discoveries) discovery.controller.abort();
    const connections = [...new Set([...this.clients.values(), ...this.retired])];
    const refreshes = [...this.refreshes.values()];
    this.clients.clear();
    this.retired.clear();
    await Promise.allSettled(connections.map((connection) => this.closeConnection(connection)));
    await Promise.allSettled([...connections.map((connection) => connection.ready), ...refreshes, ...discoveries.map((discovery) => discovery.promise)]);
  }

  async startAuthorization(name: string): Promise<URL> {
    const upstream = this.get(name);
    const redirectUri = `${this.config.publicUrl}/upstream/callback/${name}`;
    const client = await this.registration(name, redirectUri);
    const state = randomUrlSafe();
    const verifier = randomUrlSafe();
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    writeRecord(this.db, name, "pending", { client, redirectUri, state, verifier } satisfies PendingAuthorization);
    const url = this.endpoint(name, "/oauth/mcp/authorize");
    url.search = new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
      code_challenge: challenge, code_challenge_method: "S256", state,
      scope: "orchestration:read orchestration:operate", resource: upstream.url,
    }).toString();
    return url;
  }

  async finishAuthorization(name: string, params: URLSearchParams): Promise<void> {
    const upstream = this.get(name);
    const pending = readRecord<PendingAuthorization>(this.db, name, "pending");
    const code = params.get("code");
    if (!pending || !code || params.get("state") !== pending.state || params.get("iss") !== new URL(upstream.url).origin
      || pending.redirectUri !== `${this.config.publicUrl}/upstream/callback/${name}`) {
      throw new Error("Invalid upstream OAuth callback");
    }
    if (this.exchanges.has(name)) throw new Error("Upstream authorization exchange already in progress");
    this.exchanges.add(name);
    try {
      const tokens = await this.postForm(this.endpoint(name, "/oauth/mcp/token"), new URLSearchParams({
        grant_type: "authorization_code", code, code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri, client_id: pending.client.client_id, resource: upstream.url,
      }));
      if (readRecord<PendingAuthorization>(this.db, name, "pending")?.state !== pending.state) {
        throw new Error("Upstream authorization changed during exchange");
      }
      this.db.transaction(() => {
        writeRecord(this.db, name, "client", pending.client);
        writeRecord(this.db, name, "tokens", tokens);
        deleteRecord(this.db, name, "pending");
        deleteRecord(this.db, name, "state");
        deleteRecord(this.db, name, "verifier");
      })();
      const previous = this.clients.get(name);
      this.clients.delete(name);
      this.catalog.delete(name);
      this.observations.delete(name);
      this.discoveries.get(name)?.controller.abort();
      this.discoveries.delete(name);
      if (previous) await this.closeConnection(previous);
    } finally { this.exchanges.delete(name); }
  }

  private async discover(connection: Connection, signal = connection.controller.signal): Promise<Tool[]> {
    const client = await withSignal(connection.ready, signal);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const page = await withSignal(client.listTools(cursor ? { cursor } : undefined, { signal }), signal);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    signal.throwIfAborted();
    return tools;
  }

  status(): UpstreamStatus[] {
    return this.config.upstreams.map(({ name }) => {
      const observed = this.observations.get(name);
      const tools = this.catalog.get(name);
      const fresh = observed?.outcome === "ok" && observed.lastSuccessAt !== null
        && Date.now() - Date.parse(observed.lastSuccessAt) < CATALOG_FRESH_MS;
      const outcome = observed?.outcome ?? "unknown";
      const action = outcome === "sign_in_required" ? "Authorize this upstream with the existing link command."
        : outcome === "unavailable" ? "Check upstream connectivity, then retry discovery."
        : "Inspect upstream configuration and availability, then retry discovery.";
      return {
        name,
        status: outcome === "unknown" ? "unknown" : outcome === "sign_in_required" ? "sign_in_required"
          : fresh ? "fresh" : tools ? "stale" : outcome === "ok" ? "stale" : outcome,
        connection: this.clients.get(name)?.connected ? "initialized" : observed ? "not_initialized" : "unknown",
        discovery: outcome,
        observedAt: observed?.observedAt ?? null,
        lastSuccessAt: observed?.lastSuccessAt ?? null,
        catalog: { count: tools?.length ?? null, freshness: !tools ? "unknown" : fresh ? "fresh" : "stale",
          cached: observed?.cached ?? false, fallback: observed?.fallback ?? false },
        failure: outcome === "unknown" || outcome === "ok" ? null
          : { category: outcome, reason: observed!.reason!, action },
      };
    });
  }

  async catalogs(): Promise<Tool[][]> {
    // Every host shares this absolute deadline; existing flights expire earlier.
    const deadline = Date.now() + DISCOVERY_BUDGET_MS;
    return Promise.all(this.config.upstreams.map(({ name }) => {
      const observed = this.observations.get(name);
      const reusableFor = observed?.outcome === "ok" ? CATALOG_FRESH_MS : DISCOVERY_BUDGET_MS;
      if (observed && Date.now() - Date.parse(observed.observedAt) < reusableFor) {
        observed.cached = this.catalog.has(name);
        return Promise.resolve(this.catalog.get(name) ?? []);
      }
      return this.list(name, deadline);
    }));
  }

  list(name: string, deadline = Date.now() + DISCOVERY_BUDGET_MS): Promise<Tool[]> {
    const existing = this.discoveries.get(name);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const flight: Discovery = { controller, promise: Promise.resolve([]) };
    this.discoveries.set(name, flight);
    flight.promise = Promise.resolve().then(async () => {
      let connection: Connection | undefined;
      const timer = setTimeout(() => controller.abort(new DOMException("Discovery deadline exceeded", "TimeoutError")), Math.max(0, deadline - Date.now()));
      try {
        controller.signal.throwIfAborted();
        if (!readRecord<UpstreamTokens>(this.db, name, "tokens")?.access_token) {
          throw new UpstreamFailure("sign_in_required", "Upstream sign-in required");
        }
        connection = this.connect(name);
        connection.users++;
        const signal = AbortSignal.any([controller.signal, connection.controller.signal]);
        const tools = await this.discover(connection, signal);
        if (this.discoveries.get(name) !== flight || this.clients.get(name) !== connection) throw new Error("Upstream discovery superseded");
        const now = new Date(Date.now()).toISOString();
        this.catalog.set(name, tools);
        this.observations.set(name, { outcome: "ok", observedAt: now, lastSuccessAt: now, cached: false, fallback: false });
        return tools;
      } catch (error) {
        const timedOut = controller.signal.reason instanceof DOMException && controller.signal.reason.name === "TimeoutError";
        const failed = failure(timedOut ? controller.signal.reason : error);
        if (this.discoveries.get(name) === flight && (!connection || !this.clients.has(name) || this.clients.get(name) === connection)) {
          this.observations.set(name, { outcome: failed.status, observedAt: new Date(Date.now()).toISOString(),
            lastSuccessAt: this.observations.get(name)?.lastSuccessAt ?? null,
            cached: this.catalog.has(name), fallback: this.catalog.has(name), reason: failed.reason });
        }
        // A discovery deadline must not abort another user's native call or initialization.
        if (connection && (!timedOut || connection.users === 1)) this.discard(name, connection);
        console.warn(JSON.stringify({ event: "upstream_catalog", timestamp: new Date().toISOString(),
          stage: "fallback", upstream_index: this.config.upstreams.findIndex((item) => item.name === name),
          ...failed, cached: this.catalog.has(name) }));
        return this.catalog.get(name) ?? [];
      } finally {
        clearTimeout(timer);
        if (connection) await this.release(name, connection);
        if (this.discoveries.get(name) === flight) this.discoveries.delete(name);
      }
    });
    return flight.promise;
  }

  async call(name: string, tool: string, args: Record<string, unknown>) {
    const connection = this.connect(name);
    connection.users++;
    try { return await (await connection.ready).callTool({ name: tool, arguments: args }); }
    catch (error) {
      this.discard(name, connection);
      return { isError: true, content: [{ type: "text" as const, text: `Upstream ${name} unavailable: ${error instanceof Error ? error.message : "connection failed"}` }] };
    } finally { await this.release(name, connection); }
  }

  async doctor(): Promise<DiagnosticResult[]> {
    // Probe connections have no serving catalog or in-flight tool operations.
    const probe = new Upstreams(this.config, this.db);
    const results: DiagnosticResult[] = [];
    try {
      for (const { name } of this.config.upstreams) {
        let connection: Connection | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (!readRecord<UpstreamTokens>(this.db, name, "tokens")?.access_token) {
            throw new UpstreamFailure("sign_in_required", "Upstream sign-in required");
          }
          connection = probe.connect(name);
          const current = connection;
          timer = setTimeout(() => current.controller.abort(new DOMException("Diagnostic deadline exceeded", "TimeoutError")), 15000);
          const tools = await probe.discover(connection);
          results.push({ name, status: "ok", toolCount: tools.length });
        } catch (error) {
          const reason = connection?.controller.signal.reason;
          results.push({ name, ...failure(reason instanceof DOMException && reason.name === "TimeoutError" ? reason : error) });
        } finally {
          clearTimeout(timer);
          await probe.close();
        }
      }
    } finally { await probe.close(); }
    return results;
  }
}
