
## Build from source

```bash
git clone https://github.com/YOUR_USER/reva.git
cd reva
npm install
npm start            # run the app from source
```

On Windows you can also double-click **`start.bat`** (installs dependencies on the first run, then launches Reva) and **`build.bat`** (builds the setup, the portable zip and the source zip into `release\`).

```bash
npm run pack         # unpacked app in release/win-unpacked (fast, for testing)
npm run dist         # portable zip + Reva's own setup exe in release/
npm run setup        # rebuild only the setup exe from the portable zip
npm run zip:source   # release/reva-source-<version>.zip
```

The first `dist` run downloads Electron into the electron-builder cache. See [docs/RELEASING.md](docs/RELEASING.md).

