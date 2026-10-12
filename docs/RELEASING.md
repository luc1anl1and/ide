# Releasing

Packaging configuration lives in the `build` key of `package.json` (electron-builder). Output goes to `release/`.

## Build locally

```bash
npm ci
npm run pack            # release/win-unpacked: quick smoke test, run Reva.exe
npm run dist            # release/Reva-Setup-<version>.exe + release/Reva-<version>-portable.zip
npm run zip:source      # release/reva-source-<version>.zip
```

- **Installer**: Reva's own setup (`installer/Setup.cs`, compiled by `scripts/build-setup.js` with the .NET Framework compiler that ships with Windows, so no SDK is needed). It is one exe: the setup program with the app zip appended as payload. Per-user (no admin), directory selectable, desktop and Start menu shortcuts, registers an uninstall entry and copies a small `Uninstall Reva.exe` next to the app. User data (`%APPDATA%\Reva`) is kept on uninstall unless the user ticks the box (or passes `/deletedata`). Silent flags: `/S`, `/D=dir`, `/nodesktop`, `/nostart`; the uninstaller takes `/uninstall /S [/deletedata]`. Test hook: `Reva-Setup.exe /shot=out.png /page=welcome|working|done` renders a page to a PNG.
- **Portable**: `zip` target of `win-unpacked`.
- **Source zip**: `scripts/zip-source.js` is a dependency-free zip writer. It packs the repo under `reva-<version>/` and skips `node_modules`, `release`, `dist`, `.git`, logs and local settings.
- Builds are unsigned (`forceCodeSigning: false`). To sign, set `CSC_LINK` / `CSC_KEY_PASSWORD` in the environment.

## Smoke test before tagging

1. `npm run pack`
2. Run `release\win-unpacked\Reva.exe`; open a folder, open a terminal tab, open the preview.
3. Whisper: pick a model in Settings > Voice & media and dictate a sentence (confirms the unpacked worker and onnxruntime load).
4. Headless: `Reva.exe --shot out.png --wait 6000 --eval "api.voice.status()"` should print `available: true`.

## Cut a release

1. Update `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Commit: `git commit -am "Release vX.Y.Z"`.
3. Tag and push: `git tag vX.Y.Z && git push origin main --tags`.
4. The `Build` workflow (`.github/workflows/build.yml`) builds on `windows-latest`, uploads the artifacts, and on `v*` tags creates a GitHub Release with the installer, portable zip and source zip attached.

## Native dependencies

`@lydell/node-pty`, `onnxruntime-node` and `sharp` ship prebuilt binaries, so no compiler is needed. The config keeps only win32-x64 binaries (other platforms are excluded in `build.files`). If you add a native dependency, add it to `asarUnpack`, run `npm run pack` and test it from the unpacked app.
