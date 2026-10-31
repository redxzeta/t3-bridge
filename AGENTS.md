# Working on T3 Bridge

- `src/` contains configuration, auth, SQLite state, upstream OAuth/routing, the HTTP server, CLI, browser code, and colocated tests. `examples/` has synthetic configuration; `docs/setup.md` owns installation guidance.
- Use Node.js 24 and pinned pnpm 12.14.0: `pnpm install --frozen-lockfile`, `pnpm run check`, `pnpm run build`, then `pnpm test`. The primary compiler is pinned tsc-ts; do not silently substitute tsc. Preserve strictness and review emitted-code behavior.
- Make focused changes using existing mechanisms. Keep dependency versions pinned; only SQLite and esbuild have build permission. Do not add infrastructure, CI workflows, or deployment mechanisms without an explicit task.
- Tests use synthetic accounts, documentation domains, disposable state, and loopback mock upstreams. Never contact a real T3 instance to run tests.
- Preserve one-owner signup restrictions, downstream OAuth, upstream state/issuer/PKCE validation, token persistence, and T3 read/write approval. Bridge authentication never grants additional T3 permissions.
- Keep configuration, secrets, signing material, OAuth URLs/state/tokens, databases, logs, archives, and scanner reports out of Git and responses. Inspect complete staged content and outgoing history using CONTRIBUTING.md before publishing.
- Repository work, publication, installation, and runtime activation are separate. A commit or PR does not authorize live deployment, host changes, service restarts, or upstream operations.

## Helping an operator

- For installation, use `.agents/skills/t3-bridge-setup/SKILL.md` and `docs/setup.md`. Discover the actual host, configuration, state and upstreams; examples are not deployment inventory.
- For ChatGPT connection expiry, use `.agents/skills/t3-bridge-diagnose/SKILL.md` and `docs/chatgpt-oauth.md`. Check the selected connection's requested scopes and refresh-token issuance before blaming tunnel availability. Never assume an existing app exposes an OAuth editor or Refresh control.
- Explain which steps require the owner's browser and LAN/VPN access. Ask only for inaccessible account facts or user consent; continue independent authorized diagnostics. Report initial tool access, post-expiry renewal, process recovery and remaining uncertainty separately.
