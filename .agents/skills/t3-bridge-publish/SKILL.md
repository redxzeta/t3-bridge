---
name: t3-bridge-publish
description: Prepare and verify public T3 Bridge repository changes with staged-content review, redacted secret scans, private-identifier checks, and outgoing-history inspection.
---

Read [CONTRIBUTING.md](../../../CONTRIBUTING.md) for the maintained validation and publication procedure and [the setup guide](../../../docs/setup.md) when checking installation instructions. Resolve these links from this skill directory.

Identify the intended repository, branch, publication target, and explicitly authorized action. Preserve unrelated work. Review the exact staged paths and their complete indexed contents, including fixtures, documentation, binary files, and metadata. Exclude deployment/state artifacts before staging rather than relying on scanners to remove them.

Run the documented checks and redacted Gitleaks scans on staged content. Separately check private deployment identifiers using a local-only list outside the repository. Inspect repository history, every outgoing commit, and author/committer metadata before pushing. Keep all lists, snapshots, and scanner reports outside Git with private permissions.

Investigate findings locally. Never echo detected values into chat, issues, PRs, or commits. Do not broadly suppress findings or rewrite already-published history without explicit authority. If a finding remains unresolved, stop publication and describe the affected category without revealing its value.

Commit and push only reviewed, clean changes within the user's authorization. Verify the remote revision matches the checked commit, and report the PR or branch and exact validation status. Repository publication does not authorize npm publishing, a release, deployment, service activation, or upstream actions.

Validate both documented transport examples using synthetic state. CI must remain read-only and synthetic, with pinned action commits, production audit, and redacted full-history scanning. Do not upload local deployment identifiers or scanner reports. Keep source-only distribution unless package publication is separately authorized.
