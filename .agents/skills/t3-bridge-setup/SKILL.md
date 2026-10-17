---
name: t3-bridge-setup
description: Guide manual T3 Bridge installation on Linux, macOS, or WSL2, local credential initialization, upstream authorization, and MCP connection troubleshooting.
---

Read [the setup guide](../../../docs/setup.md) for maintained commands, supported platforms, configuration, recovery, and troubleshooting. Read [contribution guidance](../../../CONTRIBUTING.md) before preparing repository changes. Resolve these links from this skill directory.

Establish the platform and whether the user is initializing a fresh checkout or operating an existing installation. Follow the documented order: configure, frozen install/check/build, initialize the owner, start the bridge and ngrok, authorize each upstream, then connect the MCP client. Preserve existing signing material and accounts; a restart never requires setup.

Have the operator run credential commands in their own unrecorded terminal. Do not collect passwords, signing keys, ngrok tokens, configuration, OAuth URLs, or databases in chat or tool output. Use synthetic examples for diagnostics.

Explain that the browser must reach the upstream authorization origin and the public bridge callback, while the bridge must reach upstream MCP. A private upstream need not become public. Match the configured HTTPS origin to the active tunnel and use the newest instance link URL.

Check bridge authentication, upstream authorization, catalog discovery, and actual tool invocation separately. T3 read/write approval remains a separate decision enforced by T3; never change permissions or invoke a write merely to prove connection success.

Setup guidance is not authority to modify an existing deployment, restart services, change host networking, or perform upstream operations. Stay within the user's requested installation or diagnostic scope. Label unavailable platform verification explicitly and keep diagnostics redacted.
