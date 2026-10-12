# Security Policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/YOUR_USER/reva/security/advisories/new)
(Security tab > Report a vulnerability) and include:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- the affected version.

You can expect an acknowledgement within a few days. Please give us reasonable time to fix the issue before public disclosure.

## Threat model notes

- Reva runs coding agents that can read and modify files and execute commands on your machine. This is by design; use the agents' permission modes accordingly. "Bypass all" disables the agent's permission prompts.
- The built-in MCP tools server listens on `127.0.0.1` only, requires a random bearer token, and rejects requests that carry a browser `Origin` header or a foreign `Host` header.
- API keys are encrypted with Electron `safeStorage` (Windows DPAPI). They are decrypted only in the main process and handed to agent processes through environment variables.
- The renderer runs with `contextIsolation: true` and `nodeIntegration: false`; the preload script exposes a fixed set of IPC calls. The preview `<webview>` uses a separate persistent partition.
- PC control (`pc_*` tools, including desktop screenshots) stays off the agents' radar until you allow it: every first use shows a native Windows dialog (allow once / allow for this session / deny), control actions are shown in the pet bubble while they happen, and **Stop** in the pet toolbar or the tray menu revokes everything. It uses Windows UI Automation and synthetic mouse/keyboard input in a separate PowerShell helper and can be disabled under Settings > Pet & PC control. Treat "allow for this session" like handing over your keyboard.
- Release builds are not code-signed. Verify downloads against the checksums published with a release.
