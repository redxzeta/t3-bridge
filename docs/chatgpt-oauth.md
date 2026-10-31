# ChatGPT OAuth setup and reconnect troubleshooting

Use this with [manual setup](setup.md) and the [private tunnel runbook](secure-mcp-tunnel.md). These instructions preserve the existing one-owner account, signing identity and upstream grants. They do not provision services or authorize a deployment.

## Connect with renewable authorization

1. Confirm the bridge and chosen tunnel are running, the configured upstreams are linked, and the owner browser can reach the real bridge HTTPS origin with valid CA trust.
2. In ChatGPT, add a custom MCP server. For Secure MCP Tunnel, select **Connection: Tunnel**, choose the existing intended tunnel, and select **OAuth**. Do not create another tunnel or change the server's canonical origin for this step.
3. If the creation dialog offers **Advanced OAuth settings**, inspect discovery rather than overriding issuer, endpoints or client identity. Under **Scopes**, retain `mcp:tools` in the existing/default scopes and enter this exact value under **Base scopes**:

   ```text
   offline_access
   ```

   Base scopes are requested on every authorization request. Default scopes may be replaced by the selected tools' declared scopes. A misspelling such as `offlineaccess` is a different scope. Do not add unrelated identity or T3 operation scopes.
4. Create the plugin, sign in to the bridge if requested, and approve access. An existing browser session may allow consent without entering a password again. Confirm the requested/granted scopes rather than relying on the button label.
5. Select this exact app in a new ChatGPT conversation and invoke one read-only tool for each configured upstream. Discover actual names; the prefixes come from configuration. Do not start an agent job or change permissions to prove connectivity.

The bridge's per-tool `_meta.securitySchemes` advertises `mcp:tools` and `offline_access` using the extension field supported by its pinned SDK. The runtime still enforces only `mcp:tools`: offline access requests renewable authorization, not extra T3 permissions. Authorization-server discovery advertising a scope is not proof that ChatGPT requested or the owner granted it. Explicit Base scopes and actual refresh-token issuance are the acceptance evidence.

UI controls vary by account and rollout. If Base scopes is absent, inspect current official guidance and the controls actually shown; do not invent a menu or assume a packaged-plugin manifest changes a native Tunnel connection.

## Existing app with no editor or Refresh control

Workspace admins may have a tool/action refresh control. A personal Plus/Pro connection may not expose that control or an editor for saved OAuth Base scopes. A server deployment does not establish that a saved ChatGPT tool snapshot or authorization has changed.

- If an editor exists, preserve existing scopes, add `offline_access` to Base scopes, save, and reauthorize once with owner consent.
- If it does not, preserve the original app and create one separately named test connection to the **same tunnel**, using the corrected scopes. A test created before a metadata correction does not validate that correction.
- Select only the intended connection during acceptance, so an old app cannot mask the result. Do not delete the original, reset OAuth state, revoke unrelated grants or repeatedly recreate apps as a diagnostic loop.
- Confirm renewal before replacing the old connection or updating skills/integrations that reference it. A new connection's refresh token is not automatically installed into the old connection, even if both share a CIMD client identity.

## Why the browser may need LAN or VPN access

Tool traffic reaches the private bridge through OpenAI Tunnel. The browser authorization endpoint is not exposed by that tunnel: the browser opens the real bridge login/consent origin directly. With a private origin, fresh login or consent needs LAN, wired network or an existing VPN route, plus CA trust on that device. Upstream authorization also needs browser access to the upstream and bridge callback.

Normal ChatGPT tool use can work from outside that network. Automatic refresh is a server-to-server operation; it need not use the user's browser network when the private token endpoint is correctly registered and reachable through the OAuth shim. Verify that route rather than promising remote reconnection or publishing the bridge to fix browser reachability.

## Token lifetime and acceptance

The pinned provider defaults to a one-hour access token and a 30-day refresh token. It rotates refresh tokens on successful refresh and issues a replacement with a new expiry under the current policy. This is not a universal monthly reconnect requirement or proof of unlimited session lifetime: revocation, provider policy, client persistence and network availability still matter. Do not lengthen token lifetimes to conceal a missing grant.

Record these results separately:

1. **Initial access:** the exact selected connection successfully invokes a read-only tool for each configured upstream. Inspect application results, not just transport status.
2. **Renewable grant issued:** with authorized server access, verify the relevant consent includes `offline_access` and a refresh token was issued for this authorization. Inspect only scope, creation/expiry and revocation/rotation metadata. Use read-only queries against the discovered active state; never export token values, signing keys, database copies or session cookies.
3. **Post-expiry access:** after the configured access lifetime plus a small margin, use the same connection for read-only calls without manual Reconnect. Record timestamps/timezone and any prompts. Use the actual lifetime if customized; do not create a scheduler or synthetic keepalive unless requested.
4. **Actual refresh:** correlate the original refresh record with its replacement in the same authorization family. Record rotation/issuance timestamps, not token identifiers. Shared client IDs alone cannot distinguish app connections. A successful call before expiry or a newly issued authorization code is not refresh proof.
5. **Sustained reliability:** longer idle periods, further renewal cycles, bridge/tunnel restarts and upstream outages are separate observations. One successful refresh does not prove every operation or overall process stability.

When a result requires inaccessible ChatGPT account state, describe the exact owner action and mark that result pending. Do not weaken authentication or mint a synthetic production credential to manufacture acceptance.

## Identify the failure boundary

| Evidence | What to investigate next |
| --- | --- |
| Expired connection; no `offline_access` grant or refresh token | Requested Base/tool scopes, owner consent and current app metadata |
| Renewal fails after a renewable grant was issued | Endpoint HTTP result, client identity validation, expiry/revocation and rotation handling |
| Login/consent page will not load | Browser LAN/VPN route and CA trust; tunnel readiness cannot establish browser reachability |
| Tunnel ready but ChatGPT sends no request | Selected app, cached tool snapshot and hosted connection state; preserve private support identifiers |
| Polls succeed but results fail | Dispatcher, queue and response-delivery component snapshots |
| Bridge exits or tools return 502 | Process exit category, resource use and upstream availability, separately from OAuth |
| One upstream fails while another works | That upstream's connectivity/grant and catalog fallback; do not reset every grant |

Discover the configured health listener. Read `/healthz` (liveness), `/readyz` (readiness), and the installed version's `/health/control-plane`, `/health/dispatcher`, `/health/queue` and `/health/response-delivery` diagnostics when available. Component snapshots may return HTTP 200 even for a degraded component. Do not attach a second diagnostic runtime to the production tunnel.

For retained logs, prefer existing Grafana/Loki access, discover selectors, use explicit UTC windows and a bounded limit (for example 100 lines), and record truncation. Never turn raw HTTP/payload logging on merely to troubleshoot a reconnect. An empty bounded query is not proof of historical reliability. Follow [official troubleshooting](https://github.com/openai/tunnel-client/blob/master/docs/troubleshooting.md) for the installed release.

Keep heap exhaustion or crashes open as separate defects even if renewal passes. Preserve single-attempt mutation behavior: after an ambiguous timeout, inspect retained upstream state instead of automatically replaying work.

## Maintained upstream references

- [OpenAI custom MCP connections and offline access](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- [OpenAI OAuth and tool auth declarations](https://developers.openai.com/plugins/build/auth)
- [OpenAI tool metadata reference](https://developers.openai.com/plugins/reference#_meta-fields-on-tool-descriptor)
- [Tunnel browser authorization and OAuth routing](https://github.com/openai/tunnel-client/blob/master/docs/architecture.md#auth-and-data-flow-matrix)
- [Better Auth token lifetimes and refresh behavior](https://better-auth.com/docs/plugins/oauth-provider)

Check current documentation and installed versions before giving UI-specific or upgrade instructions. Reports from other deployments are leads, not verified fixes for this installation.
