# Contributing to Reva

Thanks for your interest! Bug reports, ideas and pull requests are all welcome.

## Getting started

Requirements: Windows 10/11, Node.js 20+, npm. Optional: Claude Code, Codex or OpenCode CLIs to try the agents.

```bash
git clone https://github.com/YOUR_USER/reva.git
cd reva
npm install
npm start
```

## Project layout

```text
src/main.js          main process: window, IPC, agent lifecycle
src/preload.js       the only bridge exposed to the renderer (window.api)
src/agents/          Claude Code (in main.js), Codex, OpenCode, custom agent adapters + CLI installer
src/ide-mcp.js       MCP server that exposes IDE tools to agents
src/term.js          node-pty terminals
src/ports.js         preview helpers (port scan, DevTools docking, capture)
src/store.js         settings, encrypted API keys, chat store
src/voice/           local Whisper (worker thread)
src/renderer/        UI (plain JS and CSS, no bundler)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces talk to each other.

## Guidelines

- Keep it dependency-light. The renderer is plain JavaScript on purpose; do not add a framework or bundler without discussion.
- Every new IPC channel needs a handler in the main process **and** an entry in `src/preload.js`. Do not expose `ipcRenderer` itself.
- Validate anything that comes from the renderer or from an agent before touching the file system or spawning processes.
- Never commit secrets, personal paths, session ids or screenshots containing personal data.
- Agent adapters must emit the shared event protocol (Claude-Code stream-json shaped events); the renderer should not need to know which backend is running.
- Style: 2 spaces, single quotes, semicolons, LF line endings (see `.editorconfig`).

## Before you open a pull request

1. `node --check` every JS file you changed.
2. Run the app (`npm start`) and exercise the feature, including the terminal and preview if you touched them.
3. If you changed dependencies or packaging, run `npm run pack` and start `release\win-unpacked\Reva.exe`.
4. Update `CHANGELOG.md` for user-visible changes.

There is a screenshot harness for UI work: `electron . --shot out.png --wait 4000 --eval "<js>"` renders the app invisibly, runs the JS in the renderer and saves a PNG. It uses a temporary user-data directory.

## Reporting bugs and requesting features

Use the issue templates. For security issues, do **not** open a public issue; see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
