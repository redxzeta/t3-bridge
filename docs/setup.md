# Manual setup

## Prerequisites

- Node.js **24** and pnpm **12.14.0**. Install Node.js from [nodejs.org](https://nodejs.org/en/download), then install the pinned pnpm version using the [pnpm installation guide](https://pnpm.io/installation). Confirm `node --version` and `pnpm --version`. The repository's `packageManager` field pins pnpm; its launcher may download that version.
- Git, a browser, and ngrok with an account/domain available for an HTTPS endpoint. Configure ngrok authentication locally using its [official instructions](https://ngrok.com/docs/getting-started/). Keep its credential out of this repository and chat.
- Network access from the bridge to each T3 `/mcp` endpoint. Your browser must also reach each T3 authorization page. Enable MCP in each T3 instance and retain its existing permissions.

The primary compiler, tsc-ts 0.0.2, is experimental. Published optional packages cover Linux x64/arm64 (glibc or musl) and macOS x64/arm64. Leave optional dependencies enabled. Unsupported platforms fail explicitly; this project does not build the compiler from source. Node.js is still required to run T3 Bridge.

SQLite normally uses a prebuilt native addon. If installation falls back to a native build, use the platform's Python 3 and C/C++ build tools (Linux build tools or macOS Xcode Command Line Tools), then retry. Only SQLite and esbuild have dependency build permission. Do not enable all dependency scripts to fix an installation error.

On macOS, use the foreground commands below initially. On Windows, install Node.js, pnpm, Git, and ngrok **inside WSL2**, keep the checkout in its Linux filesystem, and follow these Linux commands. ngrok and the bridge must run in the same WSL environment so loopback resolves correctly. Native Windows execution is outside this guide.

## Configure and build

```sh
git clone https://github.com/redxzeta/t3-bridge.git
cd t3-bridge
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
cp examples/config.example.json config.json
```

Edit `config.json` before setup:

- `publicUrl`: your stable **HTTPS origin**, without a path, query, credentials, or fragment. Replace `https://bridge.example.com` with your ngrok-assigned domain or a domain configured for your ngrok account. A trailing slash is accepted and normalized.
- `listenPort`: an unused port from 1024 through 65535, such as 8787. The bridge always binds to `127.0.0.1`.
- `ownerEmail`: the single owner's login name. No email delivery or external identity provider is required.
- `upstreams`: one to eight named HTTP or HTTPS URLs whose path is exactly `/mcp`. Names must be unique, start with a lowercase letter, use lowercase letters/digits/single underscores, end in a letter/digit, and be at most 31 characters. Names become tool prefixes; choose them before authorizing.

The example uses `home` and `lab` with documentation-only hostnames. Replace them with your own reachable URLs. Embedded credentials, query strings, and fragments are rejected.

**Plain HTTP upstreams are a trusted-network choice.** OAuth tokens, T3 sign-in traffic, and tool data sent over HTTP are unencrypted on that network. Use HTTPS where the network is not trusted. Public bridge traffic always requires HTTPS.

## Initialize the owner

In your own interactive terminal, without recording or redirecting output:

```sh
pnpm run setup
```

Setup uses the edited configuration, creates a random signing secret in `.env`, initializes `state/gateway.sqlite`, and creates the owner with a random **128-character password**. Save the password from the terminal immediately. It is not saved in plaintext or printed again.

`.env` and database files are private (`0600`); the state directory is `0700`. These files are ignored by Git. Use a dedicated state directory owned by the operator. Protect backups of the configuration, environment, and state together; they contain secrets and account/grant state.

Setup refuses an existing `.env`, an inherited `BETTER_AUTH_SECRET`, or an existing account. It never replaces signing material or resets an account. Runtime public signup is disabled, regardless of old bootstrap environment variables.

If setup fails after writing `.env`, it keeps that material and reports the failure. Do not repeatedly rerun setup, replace a signing key, or delete state from an existing installation. For a confirmed disposable, brand-new setup with no account or grants to preserve, inspect the failure locally, remove only that failed attempt's `.env` and state, fix the cause, and initialize again. Otherwise preserve the files and investigate before recovery. Never post them in an issue.

## Start the bridge and tunnel

From the checkout:

```sh
pnpm start
```

Leave it running. In a second terminal, start ngrok using the same origin and port configured above:

```sh
ngrok http --url=https://bridge.example.com 127.0.0.1:8787
```

Replace the example domain with your assigned ngrok domain. Availability of custom domains depends on your ngrok account. Do not add ngrok browser authentication in front of MCP: the bridge provides OAuth authentication itself.

The HTTPS `/sign-in` page should load. `POST /mcp` without a token returns **401**; that is expected authentication enforcement. The database is initialized during setup, not automatically migrated on every start.

`pnpm start`, `link`, and `rotate-password` load `.env` from the working directory. Advanced local overrides are `T3_BRIDGE_CONFIG` and `T3_BRIDGE_STATE_DIR`; keep these consistent for every command. The default files are `config.json` and `state/`. Setup always writes `.env` in the working directory. Do not set a preexisting signing secret when initializing a new installation.

## Authorize every upstream

While the bridge and ngrok are running, use a third terminal:

```sh
pnpm run link -- home
pnpm run link -- lab
```

Run one command, open its printed URL in your browser, complete the T3 login/consent, and wait for the connected confirmation before starting the next instance. Authorization URLs contain private one-time state; do not paste them into issues or chat.

The browser opens the upstream's HTTP/HTTPS origin and then returns to `https://bridge.example.com/upstream/callback/<instance>`. The browser must reach both origins, and ngrok must forward that public callback to the running bridge. A LAN upstream need not be publicly exposed. A browser on another network may need access to that LAN.

Each upstream has its own registered client, state, PKCE verifier, access token, and refresh token. Linking an instance again replaces its pending authorization while retaining its active client and tokens until successful exchange; complete the newest authorization URL. A registration with a different or unknown callback URI is staged separately and becomes active only after validation. Tokens persist across restarts. Changing an authorized instance's name or URL requires reviewing its old grant and authorizing the new configuration.

The bridge requests T3's `orchestration:read` and `orchestration:operate` scopes. **T3 read/write approval is separate:** the bridge cannot upgrade a read-only grant or override T3 tool approval. Approve only the operations you intend to allow in T3. An approval error returned by T3 remains an error through the bridge.

## Connect the MCP client

Add your public `https://bridge.example.com/mcp` URL to an MCP client that supports OAuth. For ChatGPT, use its custom MCP connection flow and Client ID Metadata Documents (CIMD) where requested. Sign in with `ownerEmail` and the generated bridge password, then approve the requested bridge scope.

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

The chosen account must own its local configuration/environment/state and have access to the built checkout. Keep Node paths and working directory explicit. Manage ngrok separately according to its documentation; no tunnel service is installed by this repository. Credential commands remain interactive and must not run through a service journal.

For Proxmox, use an existing Linux guest and its normal console/admin route. Install the same prerequisites and follow this guide inside the guest. Ensure the guest can reach upstreams and ngrok can reach its loopback listener. No LXC creation, firewall changes, or host configuration are automated here.

## Troubleshooting

- **Compiler executable missing:** verify the pinned versions and reinstall with optional dependencies enabled on a supported platform. Do not substitute another compiler silently.
- **Setup refuses existing state:** use the existing installation for a restart; inspect local files before deciding whether a failed fresh setup is disposable.
- **Callback unreachable:** verify the configured public origin matches ngrok, the tunnel forwards the configured port, and the bridge is running. Check browser access to the upstream too.
- **Invalid callback:** use the newest link URL for that instance. State and issuer must match and the authorization code is single-use.
- **401 at MCP:** complete downstream OAuth; opening `/mcp` directly is not an authenticated tool invocation. Check the client has the correct public resource URL.
- **No tools or one missing prefix:** authorize the affected upstream, check connectivity, and refresh the client catalog. An unavailable/unlinked upstream can have an empty catalog; a previously seen catalog may remain cached while calls report errors. Other instances continue independently.
- **Refresh failure:** verify T3 is reachable and reauthorize the affected instance if its grant expired or was revoked. The bridge does not bypass authentication.
- **Read-only/approval error:** review the grant and approval in T3. Signing in to the bridge does not grant additional upstream authority.

Report only redacted errors and synthetic reproductions. Never attach configuration, environment files, OAuth URLs/state/tokens, databases, private hostnames, or service logs from an installation.
