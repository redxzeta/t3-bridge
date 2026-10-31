# Manual setup

## Prerequisites

- Node.js **24** and pnpm **12.14.0**. Install Node.js from [nodejs.org](https://nodejs.org/en/download), then install the pinned pnpm version using the [pnpm installation guide](https://pnpm.io/installation). Confirm `node --version` and `pnpm --version`. The repository's `packageManager` field pins pnpm; its launcher may download that version.
- Git, a browser, and **one** transport: an ngrok account with available endpoint quota, or OpenAI Secure MCP Tunnel access. The private route also needs a stable private IPv4 address, a trusted private CA, and LAN/VPN browser access. Configure credentials locally and keep them out of this repository and chat.
- Network access from the bridge to each T3 `/mcp` endpoint. Your browser must also reach each T3 authorization page. Enable MCP in each T3 instance and retain its existing permissions.

The primary compiler, tsc-ts 0.0.2, is experimental. Published optional packages cover Linux x64/arm64 (glibc or musl) and macOS x64/arm64. Leave optional dependencies enabled. Unsupported platforms fail explicitly; this project does not build the compiler from source. Node.js is still required to run T3 Bridge.

SQLite normally uses a prebuilt native addon. If installation falls back to a native build, use the platform's Python 3 and C/C++ build tools (Linux build tools or macOS Xcode Command Line Tools), then retry. Only SQLite and esbuild have dependency build permission. Do not enable all dependency scripts to fix an installation error.

On macOS, use the foreground commands below initially. On Windows, install Node.js, pnpm, Git, and your chosen tunnel client **inside WSL2**, keep the checkout in its Linux filesystem, and follow these Linux commands. For ngrok, the agent and bridge must run in the same WSL environment so loopback resolves correctly. A private HTTPS origin must also be reachable by the browser; verify WSL networking before choosing that route. Native Windows execution is outside this guide.

## Choose a transport, configure, and build

Use `examples/config.example.json` for ngrok or `examples/private-https.example.json` for Secure MCP Tunnel. Do not start both as a fallback pair. For a migration, preserve the existing configuration, database, signing material, and grants first; see the [tunnel runbook](secure-mcp-tunnel.md).

```sh
git clone https://github.com/redxzeta/t3-bridge.git
cd t3-bridge
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
```

Copy **one** example for a fresh installation, then edit it:

```sh
# ngrok:
cp examples/config.example.json config.json
# Or, instead, for Secure MCP Tunnel:
# cp examples/private-https.example.json config.json
```

Edit `config.json` before setup:

- `publicUrl`: the real **HTTPS origin**, without a path, query, credentials, or fragment. For ngrok, use the assigned public origin. For Secure MCP Tunnel, use the stable private IPv4 HTTPS origin with an unprivileged port, such as `https://10.0.0.10:9443`. A trailing slash is accepted and normalized.
- `listenPort`: an unused backend port from 1024 through 65535, such as 8787, bound to `127.0.0.1`.
- `privateHttps`: only for the private route; certificate/key files for the extra native HTTPS listener. It binds to the exact IPv4 address/port from `publicUrl`, distinct from the backend. Paths are relative to the working directory unless absolute. The server validates the IP SAN, dates, and matching key before starting either listener.
- `ownerEmail`: the single owner's login name. No email delivery or external identity provider is required.
- `upstreams`: one to eight named HTTP or HTTPS URLs whose path is exactly `/mcp`. Names must be unique, start with a lowercase letter, use lowercase letters/digits/single underscores, end in a letter/digit, and be at most 31 characters. Names become tool prefixes; choose them before authorizing.

The example uses `home` and `lab` with documentation-only hostnames. Replace them with your own reachable URLs. Embedded credentials, query strings, and fragments are rejected.

**Plain HTTP upstreams are a trusted-network choice.** OAuth tokens, T3 sign-in traffic, and tool data sent over HTTP are unencrypted on that network. Use HTTPS where the network is not trusted. Browser OAuth always requires a real HTTPS origin. The OpenAI tunnel does not encrypt a separate plain-HTTP upstream LAN leg.

## Initialize the owner

In your own interactive terminal, without recording or redirecting output:

```sh
pnpm run setup
```

Setup uses the edited configuration, creates a random signing secret in `.env`, initializes `state/gateway.sqlite`, and creates the owner with a random **128-character password**. Save the password from the terminal immediately. It is not saved in plaintext or printed again.

`.env` and database files are private (`0600`); the state directory is `0700`. These files are ignored by Git. Use a dedicated state directory owned by the operator. Protect backups of the configuration, environment, and state together; they contain secrets and account/grant state.

Setup refuses an existing `.env`, an inherited `BETTER_AUTH_SECRET`, or an existing account. It never replaces signing material or resets an account. Runtime public signup is disabled, regardless of old bootstrap environment variables.

If setup fails after writing `.env`, it keeps that material and reports the failure. Do not repeatedly rerun setup, replace a signing key, or delete state from an existing installation. For a confirmed disposable, brand-new setup with no account or grants to preserve, inspect the failure locally, remove only that failed attempt's `.env` and state, fix the cause, and initialize again. Otherwise preserve the files and investigate before recovery. Never post them in an issue.

## Start the bridge and chosen transport

### ngrok

With the public-origin configuration and no `privateHttps`, start the bridge from the checkout:

```sh
pnpm start
```

Leave it running. In a second terminal, start ngrok using the same origin and port configured above:

```sh
ngrok http --url=https://bridge.example.com 127.0.0.1:8787
```

Replace the example domain with your assigned ngrok domain. Availability of custom domains depends on your ngrok account. Do not add ngrok browser authentication in front of MCP: the bridge provides OAuth authentication itself.

An exhausted ngrok quota is an unavailable route; do not describe it as a working fallback.

The HTTPS `/sign-in` page should load. `POST /mcp` without a token returns **401**; that is expected authentication enforcement. The database is initialized during setup, not automatically migrated on every start.

### OpenAI Secure MCP Tunnel

Use the private-HTTPS example, editing its synthetic address and upstreams. Reserve the private address while keeping the host on its existing DHCP configuration. Do not open router ports. Permit the private HTTPS port only from your trusted LAN/VPN using the host's existing firewall.

For a **new** local CA and server certificate, replace the example IP below with the same address as `publicUrl`. These commands refuse to overwrite an existing TLS directory. Reuse existing keys/certificates for a restart; renewal is a separate manual operation.

```sh
(
  set -eu
  umask 077
  mkdir -p credentials
  mkdir credentials/tls
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -days 1825 -subj '/CN=T3 Bridge Private CA' \
    -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -keyout credentials/tls/ca.key -out credentials/tls/ca.crt
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -subj '/CN=T3 Bridge' \
    -keyout credentials/tls/server.key -out credentials/tls/server.csr
  cat > credentials/tls/server.ext <<'EXT'
subjectAltName=IP:10.0.0.10
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
EXT
  openssl x509 -req -in credentials/tls/server.csr \
    -CA credentials/tls/ca.crt -CAkey credentials/tls/ca.key -CAcreateserial \
    -days 365 -extfile credentials/tls/server.ext -out credentials/tls/server.crt
  openssl verify -CAfile credentials/tls/ca.crt credentials/tls/server.crt
  openssl x509 -in credentials/tls/ca.crt -noout -fingerprint -sha256
)
```

Install **only the public CA certificate** on browser devices and verify its fingerprint through your independent trusted management path. Before operating as a dedicated service, move the CA private key to administrator-only or offline storage; give the service only its server key/certificate and the public CA. Never bypass certificate warnings. Start the bridge with additive Node trust:

```sh
NODE_EXTRA_CA_CERTS="$PWD/credentials/tls/ca.crt" pnpm start
```

Follow the [official OpenAI setup](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and the [local runbook](secure-mcp-tunnel.md) to reuse/create the tunnel in the intended organization/workspace. Creators need Tunnels Read + Manage; the runtime key and connector operator need Read + Use. Verify the official client's published integrity information and current CLI help. Use a fixed reviewed version without unattended upgrades. Store the restricted runtime key in a private 0600 credential file using the host's credential mechanism; never place its value in a command argument or chat.

After the runbook's isolated synthetic transport test, run against the real private HTTPS origin in a second terminal. Substitute your local tunnel/organization IDs and configured origin; the key argument is a **file reference**:

```sh
tunnel-client doctor \
  --control-plane.tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --control-plane.organization-id "$CONTROL_PLANE_ORGANIZATION_ID" \
  --control-plane.api-key=file:"$PWD/credentials/tunnel-runtime.key" \
  --mcp.server-url https://10.0.0.10:9443/mcp \
  --ca-bundle "$PWD/credentials/tls/ca.crt" \
  --mcp.oauth-trusted-origin https://10.0.0.10:9443 \
  --harpoon.additional-transport http-streamable
```

Then use the same options with `run` instead of `doctor`, adding `--mcp.startup-wait-timeout 20s --health.listen-addr 127.0.0.1:8080 --log.format json --log.level warn`. The documented OAuth shim flags were verified with client 0.0.18; check the installed help on another release. When diagnosing an already running client, add `--health.listen-addr 127.0.0.1:0` to doctor to avoid its occupied health port.

The browser must reach the private `/sign-in` page over trusted HTTPS. The shim does not publish that page or upstream callback routes. Keep health, metrics, and admin interfaces loopback-only. Keep the same private HTTPS origin for the MCP target and OAuth discovery; an extra trusted discovery origin alone does not register forwarding targets in client 0.0.18.

### Shared operating paths

`pnpm start`, `link`, and `rotate-password` load `.env` from the working directory. Advanced local overrides are `T3_BRIDGE_CONFIG` and `T3_BRIDGE_STATE_DIR`; keep these consistent for every command. The default files are `config.json` and `state/`. Setup always writes `.env` in the working directory. Do not set a preexisting signing secret when initializing a new installation.

## Authorize every upstream

While the bridge and your chosen transport are running, use another terminal:

```sh
pnpm run link -- home
pnpm run link -- lab
```

Run one command, open its printed URL in your browser, complete the T3 login/consent, and wait for the connected confirmation before starting the next instance. Authorization URLs contain private one-time state; do not paste them into issues or chat.

The browser opens the upstream's HTTP/HTTPS origin and returns to `publicUrl/upstream/callback/<instance>`. For ngrok, the public callback is forwarded to the bridge. For the private route, the browser reaches the HTTPS bridge callback directly over LAN/VPN; the OpenAI tunnel does not publish it. The browser must reach both origins. A LAN upstream need not be publicly exposed.

Each upstream has its own registered client, state, PKCE verifier, access token, and refresh token when its server issues one. Linking an instance again replaces its pending authorization while retaining its active client and tokens until successful exchange; complete the newest authorization URL. A registration with a different or unknown callback URI is staged separately and becomes active only after validation. Tokens persist across restarts. Changing an authorized instance's name or URL requires reviewing its old grant and authorizing the new configuration.

The bridge requests T3's `orchestration:read` and `orchestration:operate` scopes. **T3 read/write approval is separate:** the bridge cannot upgrade a read-only grant or override T3 tool approval. Approve only the operations you intend to allow in T3. An approval error returned by T3 remains an error through the bridge.

## Connect the MCP client

For ngrok, add the public `https://bridge.example.com/mcp` URL to an OAuth-capable MCP client. For Secure MCP Tunnel in ChatGPT, choose **Connection: Tunnel**, select the verified tunnel, and retain **OAuth** authentication. Use CIMD when offered and supported by discovery. Sign in with `ownerEmail` and the generated bridge password, then approve the requested bridge scope.

A grant of only `mcp:tools` may issue no refresh token. The pinned auth library defaults access tokens to one hour; verify refresh or browser reauthentication for the actual client. Private browser reauthentication requires LAN/VPN access. Do not infer automatic refresh from successful discovery or old clients' token records.

Refresh/reconnect the client's tool list after linking upstreams. Expect instance-prefixed tools such as `home__...` and `lab__...`. A successful sign-in does not prove every upstream is linked or every operation has T3 approval.

## Restart and rotate

Stop the foreground bridge with Ctrl-C, then run `pnpm start` again from the same directory. Keep `.env`, configuration, and state in place. The same password and stored grants should continue to work. Do not rerun setup for a restart.

To generate a replacement password, use your interactive terminal:

```sh
pnpm run rotate-password
```

Enter the current password at the hidden prompt and save the new password shown once. Other browser sessions are revoked. Existing downstream OAuth grants may remain valid; revoke them separately with their issuer if needed. Signing-key rotation is outside this command.

## Optional Linux systemd example

This example is documentation only. After completing interactive setup and foreground verification, adapt the account, checkout path, and absolute Node.js 24 path before installing a unit. It runs the existing application; it does not provision users or manage ngrok.

```ini
[Unit]
Description=T3 Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bridge
WorkingDirectory=/opt/t3-bridge
ExecStart=/usr/bin/node --env-file=.env /opt/t3-bridge/dist/main.js start
UMask=0077
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

The chosen account must own its local configuration/environment/state and have access to the built checkout. Keep Node paths and working directory explicit. Manage the selected transport separately: use ngrok's documentation or the [Secure MCP Tunnel systemd example](secure-mcp-tunnel.md#service-operation-after-compatibility-proof). No tunnel service is installed automatically by this repository. Credential commands remain interactive and must not run through a service journal.

For Proxmox, use an existing Linux guest and its normal console/admin route. Install the same prerequisites and follow this guide inside the guest. Ensure the guest can reach upstreams and the selected transport can reach the configured local/private bridge listener. No LXC creation, firewall changes, or host configuration are automated here.

## Troubleshooting

- **Compiler executable missing:** verify the pinned versions and reinstall with optional dependencies enabled on a supported platform. Do not substitute another compiler silently.
- **Setup refuses existing state:** use the existing installation for a restart; inspect local files before deciding whether a failed fresh setup is disposable.
- **Callback unreachable:** verify the real configured origin and chosen transport. ngrok must forward the backend port; private browser callbacks require LAN/VPN access and CA trust. Check browser access to the upstream too.
- **413 on an auth endpoint:** the request exceeded 64 KiB. Correct the client request; do not raise limits to send tool payloads through auth routes. MCP payloads have separate SDK limits.
- **429 at login:** wait for the rate-limit window. Forwarded IP headers do not select a new bucket. Tunneled requests share their actual local peer; that identity is a limiter input, not proof of authentication.
- **Invalid callback:** use the newest link URL for that instance. State and issuer must match and the authorization code is single-use.
- **401 at MCP:** complete downstream OAuth; opening `/mcp` directly is not an authenticated tool invocation. Check the client has the correct public resource URL.
- **No tools or one missing prefix:** authorize the affected upstream, check connectivity, and refresh the client catalog. An unavailable/unlinked upstream can have an empty catalog; a previously seen catalog may remain cached while calls report errors. Other instances continue independently.
- **Refresh failure:** verify T3 is reachable and reauthorize the affected instance if its grant expired or was revoked. The bridge does not bypass authentication.
- **Read-only/approval error:** review the grant and approval in T3. Signing in to the bridge does not grant additional upstream authority.

Report only redacted errors and synthetic reproductions. Never attach configuration, environment files, OAuth URLs/state/tokens, databases, private hostnames, or service logs from an installation.
