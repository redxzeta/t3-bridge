# Private ChatGPT connection with Secure MCP Tunnel

The implementation supports optional private HTTPS and non-destructive upstream reauthorization. This runbook is not evidence of a verified production tunnel configuration. Keep the existing bridge and OAuth state unchanged until the synthetic tunnel and authenticated bridge checks below pass. A healthy tunnel or a discovered tool list alone is not acceptance.

Use the current [OpenAI guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [custom MCP guide](https://developers.openai.com/api/docs/guides/custom-mcp-server), and official tunnel-client [onboarding](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md), [configuration](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md), and [architecture](https://github.com/openai/tunnel-client/blob/master/docs/architecture.md). Check installed help: upstream master documentation can differ from a release. Client 0.0.18 was inspected during preparation; it has not been verified against a live bridge by this change.

## Baseline and recovery preparation

Establish a management route independent of the bridge before changing it. Discover the actual guest, checkout, revision (or deployed artifact hash), service user, unit, listener, configuration, state directory, and every configured upstream. Do not infer current guest IDs or upstreams from old examples. Inspect unit files locally without publishing environment values or command lines containing credentials. Identify whether the current agent/tool connection depends on this bridge.

Record private, redacted baseline receipts for service state, OAuth mode, prefixes, upstream connectivity, and the observed ngrok failure. Preserve the old unit, config, environment, and application artifacts outside Git. Back up SQLite with its online backup API or SQLite `.backup`, not a copy of the live database alone. For example, adapt these paths locally:

```sh
umask 077
mkdir -p /var/backups/bridge-before-tunnel
sqlite3 /opt/t3-bridge/state/gateway.sqlite \
  '.backup /var/backups/bridge-before-tunnel/gateway.sqlite'
sqlite3 /var/backups/bridge-before-tunnel/gateway.sqlite 'PRAGMA integrity_check;'
```

Capture config, signing material, and units in the same private backup set. Coordinate any credential/config writers so these files and the SQLite snapshot describe the same configuration. Never print or commit them. Do not rerun setup, reset accounts, or rotate signing keys. An exhausted ngrok quota means the preserved configuration is a rollback target, not an available working route.

## Account and synthetic proof

In [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels), select the intended organization and inspect existing resources first. The tunnel must include the intended ChatGPT workspace association. Tunnel creation/editing requires Read + Manage; runtime and app selection require Read + Use. ChatGPT permission to add/use custom MCP servers is separate. Verify all of these in the actual accounts; no extra paid infrastructure is required by this runbook, but pricing and future availability are not guaranteed.

Download the host-appropriate binary from the Platform page or [official latest release](https://github.com/openai/tunnel-client/releases/latest). Verify its published SHA-256 and inspect available provenance. Record the version/hash privately; install a fixed reviewed version with no unattended updater. Never install the bundled optional public-tunnel runtime as an alternative ingress for this migration.

Create a restricted runtime key locally, without recording the terminal. Do not use an admin key for the daemon. Use `file:` credential references supported by tunnel-client, with a root-owned `0600` source file and systemd `LoadCredential` for operation. Do not put the value in arguments, shell history, YAML, screenshots, journals, Git, or chat.

```sh
tunnel-client --version
tunnel-client help quickstart
tunnel-client help oauth
tunnel-client doctor --help
tunnel-client run --help
```

Initially run only the official embedded synthetic server, with no T3 authority. Substitute the existing tunnel identifier locally; do not publish it:

```sh
tunnel-client run --embedded-stateless-mcp-stub \
  --control-plane.tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --control-plane.api-key=file:/run/credentials/bridge-tunnel.service/control-plane-key \
  --health.listen-addr 127.0.0.1:8080
```

That credential path exists only inside the corresponding systemd service. For an interactive pilot, use a private credential file accessible to the operator instead. `doctor` does not accept the embedded-stub flags in 0.0.18: use `dev mcp-stub` plus an explicit MCP URL for a separate doctor probe, or inspect the running embedded demo's readiness. Do not manufacture a tunnel ID to satisfy diagnostics.

While the demo runs, create/install a private custom MCP plugin in the intended ChatGPT workspace using **Connection: Tunnel**. Invoke `echo` with synthetic text from ChatGPT. Record the successful invocation separately from readiness and discovery. Any demo authentication selection applies only to that disposable demo. Production must retain OAuth. Keep the demo isolated from production and remove its temporary plugin after testing.

## Authentication compatibility must be demonstrated

The intended topology is ChatGPT → OpenAI tunnel service → outbound-only tunnel-client → loopback bridge → existing private T3 MCP endpoints. OpenAI processes MCP payloads and applicable OAuth artifacts; “private listener” does not mean all data remains on the LAN.

The tunnel forwards bearer headers and protected-resource discovery. Its documented Harpoon OAuth shim can rewrite registered private discovery, registration, token, and revocation targets. Public HTTP(S) OAuth endpoints remain direct product calls. Explicitly trust only the required discovery origin using `--mcp.oauth-trusted-origin` when it differs from the configured MCP origin. This option alone does not forward endpoints. Private target classification and actual rewritten metadata must also be verified.

The shim **does not rewrite the browser authorization endpoint or expose arbitrary web routes**. A browser must independently reach the real authorization server. The bridge currently binds `publicUrl` to all of these:

| Surface | Current bridge contract | Required reachability |
| --- | --- | --- |
| Resource discovery | `/.well-known/oauth-protected-resource/mcp`; resource is `publicUrl/mcp` | ChatGPT discovery through tunnel; tunnel-client to metadata origin |
| Authorization metadata | Better Auth metadata under `/.well-known/`; issuer derived from configured auth base | Tunnel-client to advertised origin, explicitly trusted when separate |
| Browser login/consent | `/sign-in`, `/consent`, `/browser.js`, `/api/auth/*` | Owner browser directly to real HTTPS origin |
| Client registration | Better Auth advertised endpoint; CIMD supported | ChatGPT metadata retrieval; DCR through shim only if registered/re-written |
| Code/token/refresh/revocation | Better Auth advertised endpoints | ChatGPT through verified shim, or directly for unchanged public endpoints |
| Bearer validation | `mcp:tools`, configured resource, configured JWKS URL | Bridge must reach its configured JWKS URL; forwarded token must pass validation |
| Upstream registration | Each T3 `/oauth/mcp/register`; public client, S256 PKCE | Bridge to each T3 origin |
| Upstream authorization | Each T3 `/oauth/mcp/authorize`; `orchestration:read orchestration:operate` | Browser to T3, then bridge callback |
| Upstream callback | `publicUrl/upstream/callback/<name>`; state and exact T3 issuer checked | Browser directly to bridge; tunnel does not supply this route |
| Upstream exchange/refresh | Each T3 `/oauth/mcp/token`; resource is the configured T3 `/mcp` URL | Bridge to T3; tokens persisted in SQLite |
| Upstream revocation/approval | T3 controls existing grants and tool permissions; bridge has no revocation CLI | Use the upstream's supported controls only when needed |

Inspect actual advertised metadata for exact endpoint URLs and supported grants; do not infer them from route names. Verify downstream refresh and advertised revocation support separately. CIMD metadata retrieval requires the bridge to reach the client's metadata URL. Browser cookies remain secure, same-origin, and subject to Better Auth checks. The Node adapter accepts the configured HTTPS Host or its exact loopback listener Host; do not accept arbitrary forwarded-host/origin headers as authority.

The optional private HTTPS listener preserves the existing authentication implementation, provided both browser and bridge/tunnel-client can reach it and the shim handles the required private OAuth endpoints. Its compatibility with the hosted OAuth shim must still be verified through an authenticated ChatGPT pilot. Do not substitute a fictitious origin, disable TLS checks, use plain HTTP for owner login, or use a tunnel URL as `publicUrl` without demonstrating issuer/resource/audience and JWKS semantics end to end. Loopback binding alone does not provide a LAN browser route. If no suitable private HTTPS browser route already exists, stop cutover and report that missing capability before adding infrastructure.

Outside the trusted network, fresh bridge sign-in and upstream reauthorization require an existing trusted private-network access route. The outbound tunnel does not itself provide that browser access. Previously issued tokens may continue until refresh/reauthorization is needed; test this rather than promising remote login.

Keep upstream names, URLs, client registrations, and tokens intact where compatible. Changing `publicUrl` changes new callback URLs, but stored upstream registrations retain their original redirect URI. Existing refresh may still work; fresh authorization needs a registration whose redirect URI matches. The `link` command stages a replacement when the callback URI changes or legacy registration metadata does not identify it. Active tokens and registrations remain intact until successful, validated exchange. Failed or superseded callbacks do not replace the active grant. Do not delete stored records or relink an upstream unnecessarily. Downstream issuer/resource changes require separately validating or reauthorizing ChatGPT grants; never assert old grants automatically carry over.

## Service operation after compatibility proof

Use the existing host service manager. The following is a synthetic systemd example, **not an instruction to activate before authentication proof**. Adapt paths, user, free health port, and the private environment file on the actual guest. The environment file contains `CONTROL_PLANE_TUNNEL_ID`, `CONTROL_PLANE_ORGANIZATION_ID` for the associated Platform organization, and any verified discovery trust settings, not a literal API key. Compare the tunnel identifier with the current Platform detail page before diagnosing an access denial as a missing role.

```ini
[Unit]
Description=T3 Bridge private MCP tunnel
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
User=bridge
EnvironmentFile=/etc/t3-bridge/tunnel.env
LoadCredential=control-plane-key:/etc/t3-bridge/control-plane-key
ExecStart=/usr/local/bin/tunnel-client run --mcp.server-url http://127.0.0.1:8787/mcp --control-plane.api-key=file:%d/control-plane-key --health.listen-addr 127.0.0.1:8080 --log.format json --log.level warn
UMask=0077
Restart=on-failure
RestartSec=15
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Keep health/UI, metrics, and logs private. Leave raw HTTP logging, payload capture, tracing, and remote UI disabled. Inspect default logs locally before retaining them. Test with `doctor --explain` using the same configuration and credential access as the service before enabling boot startup. A `401`/`403` requires fixing access, not a rapid retry loop. Do not recreate keys, accounts, profiles, or duplicate services on a repeat installation.

Current published default limits are 600 MCP requests/minute per tunnel/calling-application grouping (fallback grouping by tunnel/user), 10 MiB for each full serialized request/response envelope including overhead, 120 seconds total including queue time, and 1,000 queued requests awaiting collection. Multiple clients do not multiply the allowance. Recheck the current OpenAI guide during deployment.

Start long T3 work asynchronously and return its identifier. Prefer short status calls and waits well below 120 seconds, leaving queue/network margin. Bound history/log queries using upstream pagination. Back off transient errors, but never blindly replay a mutation after an ambiguous timeout: first read the returned identifier or retained upstream state. The bridge currently makes one `callTool` attempt and returns errors; transport-level timeout/reconnect guarantees still need verification. Do not add a retry wrapper to make a smoke test pass.

## Acceptance, cutover, and rollback

Record each result as passed, failed, blocked, or not run:

1. Synthetic ChatGPT `echo` invocation through the intended workspace/tunnel.
2. OAuth production connection; missing/invalid bearer rejection; issuer, audience/resource, and scope enforcement. Verify actual tunnel-forwarded Host/origin behavior without weakening validation.
3. Discover actual prefixed bridge tools in ChatGPT and make one read-only call to **every configured upstream**. Verify T3 approval boundaries remain effective.
4. In a disposable project/thread only, perform a harmless supervised start/status workflow and clean up its artifacts. Do not invoke active operational jobs.
5. Exercise applicable downstream and upstream refresh or human reauthentication; retain existing grants unless incompatibility requires a specific change.
6. Restart only tunnel-client; verify another authenticated ChatGPT call. Test bridge restart only after confirming no in-flight calls, then repeat read-only calls. Do not reboot the host.
7. Verify no call depends on ngrok. Only after all acceptance checks pass, make this the intended personal route and disable ngrok **if dedicated to this bridge**. Retain its files.

Local curl, MCP Inspector, automated synthetic tests, readiness, and API-only calls are supporting evidence, not replacements for ChatGPT execution. If UI/account access is blocked, hand off the exact missing login/permission and mark end-to-end acceptance pending.

Rollback: stop/disable only the new tunnel unit, restore the preserved application artifacts/config/environment/units, and retain the current database unless a state change requires coordinated restoration. Restoring an old database can roll back rotated refresh tokens and invalidate grants; do not overwrite newer state casually. Restart only the bridge after checking active calls. Restore dedicated ngrok service settings if appropriate, but explicitly report quota exhaustion or other unavailability. No unrelated service, network, key, or grant should change.

## Native private HTTPS configuration

The optional listener serves the existing bridge handler; it adds no proxy or authentication mode. `publicUrl` remains the sole canonical issuer/resource/browser origin. For example, using a synthetic private address:

```json
{
  "publicUrl": "https://10.0.0.10:9443",
  "listenPort": 8787,
  "privateHttps": {
    "certFile": "/etc/t3-bridge/tls/server.crt",
    "keyFile": "/etc/t3-bridge/tls/server.key"
  },
  "ownerEmail": "owner@example.com",
  "upstreams": [{ "name": "home", "url": "http://10.0.0.20:3773/mcp" }]
}
```

The listener binds to the exact private IPv4 address and unprivileged port in `publicUrl`. Public/wildcard bind addresses, overlapping backend ports, incomplete TLS paths, invalid PEM, wrong-IP/expired certificates, and mismatched keys fail startup. Without `privateHttps`, the existing loopback-only behavior remains. Both listeners drain and close together; startup failure closes any listener already bound.

Reserve the address before production adoption. Create a dedicated private CA (five-year validity) and a one-year server certificate with the exact address in its IP SAN and server-auth usage. Keep the CA key root-only, and permit the bridge service to read only its server key/certificate. Never overwrite an existing CA or signing secret during repeat installation. Distribute only the public CA certificate, verify its SHA-256 fingerprint independently, and have the operator install it in the browser device's certificate store. Add that CA to Node using `NODE_EXTRA_CA_CERTS` and to tunnel-client using additive `--ca-bundle`; keep system trust enabled. Do not use certificate-warning bypasses or `NODE_TLS_REJECT_UNAUTHORIZED=0`.

For OAuth shim requests in client 0.0.18, add `--harpoon.additional-transport http-streamable`, and trust only the exact private HTTPS origin using `--mcp.oauth-trusted-origin`. This enables the documented channel transport; it grants no T3 authority. Verify the registered private OAuth targets and an actual OAuth tool call before deployment.

On an existing service, explicitly map `T3_BRIDGE_CONFIG` and `T3_BRIDGE_STATE_DIR` to its preserved files and load its existing signing secret. Never run setup against its state. Verify schema/dependency compatibility first; an unexpected migration is a blocker for separate review.

Allow TCP 9443 only in the guest's dedicated input rules and the corresponding dedicated host forwarding rules, restricted to the trusted LAN. Preserve all other drops/rules and record the exact additions for rollback. Do not flush global rules, restart unrelated firewall services, change Proxmox bridges, or open router ports. Health and metrics remain loopback-only.

Renew the server certificate manually before its one-year expiry, using the same CA and IP SAN. Validate the new certificate/key before replacing them and restart the bridge only when idle. Recheck TLS, OAuth, and an authenticated call. CA replacement requires distributing new trust separately; it is not an automatic renewal action. No renewal service or schedule is installed.
