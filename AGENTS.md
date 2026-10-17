# Working on T3 Bridge

- `src/` contains configuration, auth, SQLite state, upstream OAuth/routing, the HTTP server, CLI, browser code, and colocated tests. `examples/` has synthetic configuration; `docs/setup.md` owns installation guidance.
- Use Node.js 24 and pinned pnpm 12.14.0: `pnpm install --frozen-lockfile`, `pnpm run check`, `pnpm run build`, then `pnpm test`. The primary compiler is pinned tsc-ts; do not silently substitute tsc. Preserve strictness and review emitted-code behavior.
- Make focused changes using existing mechanisms. Keep dependency versions pinned; only SQLite and esbuild have build permission. Do not add infrastructure, CI workflows, or deployment mechanisms without an explicit task.
- Tests use synthetic accounts, documentation domains, disposable state, and loopback mock upstreams. Never contact a real T3 instance to run tests.
- Preserve one-owner signup restrictions, downstream OAuth, upstream state/issuer/PKCE validation, token persistence, and T3 read/write approval. Bridge authentication never grants additional T3 permissions.
- Keep configuration, secrets, signing material, OAuth URLs/state/tokens, databases, logs, archives, and scanner reports out of Git and responses. Inspect complete staged content and outgoing history using CONTRIBUTING.md before publishing.
- Repository work, publication, installation, and runtime activation are separate. A commit or PR does not authorize live deployment, host changes, service restarts, or upstream operations.
