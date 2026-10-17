# Contributing to T3 Bridge

Keep changes focused and preserve the single-owner architecture and T3 permission boundaries. Discuss substantial new features before implementing them. Never import configuration or state from a running installation.

## Development and validation

Use Node.js 24 and pnpm 12.14.0, pinned in the repository:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm test
```

`tsc-ts` 0.0.2 is the primary compiler for checks and JavaScript emission; esbuild bundles browser code. It is experimental, so compiler changes require verifying emitted runtime behavior as well as diagnostics. Keep platform optional dependencies enabled. Report compiler blockers without silently substituting another compiler.

The exact dependency versions are intentional. pnpm's `allowBuilds` permits only SQLite and esbuild. The exact-version release-age exceptions for tsc-ts and its platform packages permit installation of the explicitly selected compiler release; they do not approve dependency build scripts. Do not disable supply-chain controls or upgrade unrelated dependencies to resolve a concrete blocker.

Tests use Node's test runner, synthetic accounts, temporary directories, and loopback mock upstreams. Run targeted tests first, then the complete checks relevant to your change. Never contact a live T3 installation during tests. See [setup documentation](docs/setup.md) for manual terminal and restart verification. After building, run `python3 scripts/linux-smoke.py` on Linux for disposable PTY setup, hidden password rotation, and restart verification. It captures generated credentials privately and deletes its temporary state. Record Linux, macOS, and WSL2 checks separately; unavailable execution is not a pass.

## Before committing

Stage explicit paths, never an unreviewed directory import. Review `git diff --cached --name-status`, `git diff --cached --check`, and **the full indexed contents** of every staged file (`git show :path/to/file`). Review binary files separately or exclude them. Use documentation domains, example emails, generic instance names, and disposable state in fixtures.

Exclude real configuration, environment files, signing material, OAuth URLs/state/tokens, databases and sidecars, logs, archives, deployment artifacts, and scanner reports. Verify ignore rules using representative filenames with `git check-ignore --no-index`; ignore rules do not protect files already tracked by Git.

Install [Gitleaks](https://github.com/gitleaks/gitleaks) from its official releases. Use full redaction for every invocation. To scan the complete index, export it to a private temporary directory outside the repository:

```sh
umask 077
review_dir=$(mktemp -d)
git checkout-index --all --prefix="$review_dir/"
gitleaks dir --redact=100 "$review_dir"
```

Keep that directory and any scanner reports private and outside the repository; remove the temporary export when finished. The export represents the current index, so unstaged edits are not reviewed or scanned by this procedure. Re-review and rescan if staging changes.

Separately scan the staged snapshot against a local-only list of private deployment identifiers stored outside the repository. Include private hostnames, addresses, account emails, service/container identifiers, and personal paths relevant to any imported source. The list and scan output must never be committed. Report only pass/fail or sanitized locations; investigate matches locally without echoing their values. A generic secret scanner cannot prove that deployment identifiers are absent.

Use GitHub noreply email metadata for both author and committer. Set it locally for this repository using your account's actual noreply address and inspect metadata before publication.

## Before pushing

Fetch the target branch and inspect the exact outgoing range. Scan **all repository history** and **every outgoing commit**, including commit messages and author/committer metadata, for secrets and private deployment identifiers. Example Gitleaks commands:

```sh
gitleaks git --redact=100 --log-opts="--all" .
gitleaks git --redact=100 --log-opts="origin/main..HEAD" .
git log origin/main..HEAD --format=fuller
```

Also inspect full snapshots of outgoing commits: patch-only scans can miss a sensitive value split across changes. Apply the separate private-identifier check to history and snapshots too. Do not use a baseline or broad allowlist to hide an unresolved finding. Keep diagnostics local and redacted; never paste detected values into public reports.

Commit and push only reviewed, clean changes. Verify the remote branch's full commit ID matches the checked commit. Open a focused PR with behavior, checks and exact results, platform limitations, and any deliberate non-changes. Confirm its head revision matches the checked commit as well.

A push or merge does not authorize npm publication, a package release, deployment, service restarts, host changes, or upstream operations. No new CI workflow or automated deployment belongs to this migration. Report vulnerabilities privately through [SECURITY.md](SECURITY.md).
