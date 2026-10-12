# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/).

## [0.9.0]

### Fixed
- **The AI cursor now works with every agent and every monitor layout.** Claude often used `pc_launch` / `pc_key` / `pc_focus` (no target on screen) and never saw the cursor; every action now shows it (on the window it works in, next to the pet, or looking at the screen). Cursor overlays are one window per monitor (a single window across monitors with different scaling broke), the PC helper is per-monitor DPI aware, so positions are right on a second monitor, to the left of the main one, or with mixed scaling.

### Added
- `pc_windows` lists the screens (size and position in virtual-desktop pixels); `pc_screenshot` takes `monitor: active | main | all | N` (default: the screen with the active window).
- The pet walks to wherever the AI is working, also on another monitor, and wanders across all monitors.

### Changed
- README rewritten as a complete overview: every feature, the agent tool reference, custom pets, PC control.
## [0.8.0]

### Added
- **Reva's own setup**: a custom Windows 11 style installer (logo, rounded corners, light/dark to match Windows, animated progress, choose folder and shortcuts, proper uninstaller with an optional "delete my settings" box, silent mode). It replaces the generic NSIS wizard. Roomy footer buttons with hover/press animation, animated checkboxes (the tick draws itself), a focus glow on the path box, sliding page transitions, a breathing logo glow and an animated success badge.
- **The AI never uses your mouse**: `pc_click`, `pc_drag` and `pc_scroll` inject touch input / window messages (or use a control's own action), your pointer stays put; the AI has its own visible purple cursor, also while it takes screenshots, and it starts from the pet. Testing a page in the preview shows the same AI cursor inside the page.
- **Smarter launching**: `pc_windows` lists minimized (taskbar) windows too; `pc_launch` / `pc_snapshot` / `pc_focus` bring an already-open app to the front (restoring it from minimized) instead of starting a second copy.

### Changed
- Agents are told not to type commands into Win+R or terminals to open apps.
- Silent uninstall keeps your data unless `/deletedata` is passed.
## [0.7.0]

### Added
- **Approvals on the pet**: permission requests (commands, edits, questions, plans) appear next to the pet with Allow / Always allow / Deny (or the answer options), and in its Activity tab.
- **Thinking**: the pet shows a thought cloud while an agent is thinking.
- **Desktop vision and an AI cursor**: `pc_screenshot` (main screen, one window or all screens, with exact pixel mapping) and `pc_move`; every PC action first glides a visible purple AI cursor to its target (the pointer itself also glides instead of teleporting), and the pet walks over next to it.
- Agents are told to use the `pc_*` tools when you ask them to open or do something on your PC.

### Changed
- The pet (and the cursor overlay) are tool windows: no taskbar button, not listed in Alt+Tab or Task View.
- Chat header icons: clearer Undo icon, and the buttons can no longer shrink or be clipped.

## [0.6.0]

### Added
- **Desktop pet**: a transparent always-on-top companion that roams the screen, is draggable, reacts to your agents (working, ready, needs approval, error) with animations and speech bubbles, and opens a toolbar on click: ask any agent a question without opening the IDE, and an **Activity** list of every chat with open / stop. Uses Codex pets (codex-pets.net) or your own (zip, folder or a single picture); Reva ships its own pet. See `docs/PETS.md`.
- **Runs in the tray**: closing the window hides Reva so the pet and running agents keep going; Quit from the tray menu.
- **Agents can use the preview page without screenshots**: `preview_snapshot` (text + numbered interactive elements), `preview_click`, `preview_type`, `preview_hover`, `preview_press`, `preview_scroll`, `preview_wait`, with real trusted input events.
- **PC control for agents (asks permission)**: `pc_windows`, `pc_snapshot`, `pc_click`, `pc_type`, `pc_key`, `pc_focus`, `pc_scroll`, `pc_drag`, `pc_read`, `pc_launch`, `pc_wait` through Windows UI Automation. A native dialog asks first (once / this session / deny); revoke from the pet or the tray; can be disabled in Settings.
- Windows notifications now carry the Reva name and icon, and clicking one opens the chat.

### Changed
- Splash screen: just the pulsing, glowing logo.
- Dragging a pane edge (chat, sidebars, terminal) follows the mouse exactly and no longer jumps or loses the cursor over the browser preview.
## [0.5.0]

### Added
- **Dockable panels**: Files, Search, Chats, Agents and MCP can live in the left or the right sidebar (right-click a tab or use the panel's move button), and Files / Search / Chats / MCP can be **unpinned into their own window** and docked back.
- **Rebindable keyboard shortcuts** (Settings → Shortcuts): click a shortcut, press the new keys. New defaults for files, search, chats, tab switching and focus mode.
- **Tab strips** (editor and chats): soft edge shadows, scroll arrows and an "all tabs" list button.
- **Tool cards** in the chat now have labelled Command / Result / Diff blocks with Copy and Expand.
- Splash screen with a pulsing glow and a loading bar; `build.bat` (installer + zips) and a self-installing `start.bat`.

### Changed
- Hiding the chat from focus mode takes you to the editor; opening a file from focus mode shows the editor between the sidebar and the chat.
- Agent cards show "Connected" with a larger check mark and the plan (e.g. Max, Plus) as a separate badge.
- The logo is fixed (the "change logo" setting was removed); the installer uses the default Windows installer icon.
- Clicking a dropdown button again closes it instead of re-opening it.

### Fixed
- "Collapse all" in the file tree could be undone by a late re-render.
## [0.4.0]

### Added
- **Plugin system**: install, create and hot-reload extensions (commands, sidebar panels, status items, themes, snippets, languages, slash commands, agent tools exposed to Claude/Codex/OpenCode through the built-in MCP server). Eight example plugins, a manager UI and full developer docs in `docs/extensions`.
- **File review**: after every agent turn a "N files changed" card shows +/- counts with a side-by-side diff, Revert and Keep per file. Undo restores files regardless of how the agent changed them (workspace checkpoints).
- **Sub-agents**: live cards inside the chat for sub-agents and background tasks, and an **Agents** panel listing every chat with its sub-agents; stop or close them individually.
- **Auto context**: the file open in the editor (and your selection) is shared with the agent automatically; toggle it per message from the composer chip.
- **New file dialog** with extension shortcuts, sub-folders and starter templates; **Quick open** (Ctrl+P).
- **Splash screen**, new app icon, cleaner editor (visible indent guides, no minimap/ligatures by default), always-on start screen with "continue from your last chat".

### Changed
- Custom agents no longer have a logo or color; they use a neutral icon.
- Permission cards, chat list and settings were redesigned.

### Fixed
- Confirm/prompt dialogs always returned "cancel" (broke Undo, deletes, new names).

## [0.3.0] - 2026-10-12

First public release.

### Added
- Multi-agent chat for **Claude Code**, **Codex** and **OpenCode**, plus custom agents (OpenAI-compatible HTTP APIs and command-line agents), all behind one event protocol.
- Monaco editor with tabs, themes and "Add selection to chat".
- Real terminal (node-pty + xterm.js, ConPTY) with multiple tabs and shell profiles (PowerShell, cmd, pwsh, WSL).
- Embedded browser preview with device sizes, live reload, docked DevTools and screenshots to chat.
- Built-in MCP server (`reva-ide`) giving agents access to the editor, preview and terminal.
- Local Whisper voice transcription (offline after the first model download).
- Image, audio, video and file attachments.
- Undo / retry with file checkpoints; past-session browser and resume.
- Usage and rate-limit display, MCP server manager, agent installer and sign-in helper.
- Themes (dark and light), custom theme import/export, fonts, UI scale, focus layout.
- API keys encrypted with Windows DPAPI.
- Windows NSIS installer (per-user, no admin) and portable zip; source zip script.
