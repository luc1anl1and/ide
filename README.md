
# hyper-ide

A desktop IDE built around command-line coding agents (Claude Code, Codex, OpenCode and custom agents) with an editor, real terminal, browser preview and local voice input.

## Build from source

```bash
git clone https://github.com/luc1anl1and/ide.git
cd ide
npm install
npm start            # run the app from source
```

On Windows you can also double-click **`start.bat`** (installs dependencies on the first run, then launches hyper-ide) and **`build.bat`** (builds the setup, the portable zip and the source zip into `release\`).

```bash
npm run pack         # unpacked app in release/win-unpacked (fast, for testing)
npm run dist         # portable zip + hyper-ide's own setup exe in release/
npm run setup        # rebuild only the setup exe from the portable zip
npm run zip:source   # release/hyper-ide-source-<version>.zip
```

The first `dist` run downloads Electron into the electron-builder cache. See [docs/RELEASING.md](docs/RELEASING.md).


