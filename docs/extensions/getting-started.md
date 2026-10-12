# Getting started

Build, install and run your first Reva plugin in about five minutes. Two routes lead to the same result: the in-app wizard, or a folder you write by hand.

Requirements: Reva 0.4.0 or newer. No Node.js, no bundler, no `npm install`.

## Route 1: the wizard (2 minutes)

1. Press **Ctrl+Shift+X** (or *Settings > Plugins*, or the command palette: *Plugins: Create New Plugin...*).
2. Open the **Create** tab, type a name such as `My First Plugin`, pick the **Command** template and press **Create plugin**.
3. Reva writes the folder, enables it, starts it and opens `index.js` in the editor:

   ```js
   exports.activate = (reva) => {
     reva.commands.register('sayHello', () => {
       reva.ui.toast('Hello from My First Plugin!');
       reva.log.info('sayHello ran');
     });
   };
   exports.deactivate = () => {};
   ```
4. Press **Ctrl+Shift+P**, type `Say Hello`, press Enter. A toast appears.
5. Change the toast text and press **Ctrl+S**. The plugin reloads on its own (it takes about half a second). Run the command again.

Other templates: **Sidebar panel**, **Colour theme** (no code), **Agent tool**, **Language + snippets**. Or click **Build with AI** to have an agent write the plugin ([details](README.md#let-an-ai-write-it-for-you)).

## Route 2: by hand (3 minutes)

Create a folder in the user plugins folder (Plugins > Installed > *Open plugins folder*; it is `%APPDATA%\Reva\plugins`). The folder name should equal the plugin `id`.

```
%APPDATA%\Reva\plugins\
  hello-by-hand\
    plugin.json
    index.js
```

`plugin.json`:

```json
{
  "id": "hello-by-hand",
  "name": "Hello By Hand",
  "version": "0.1.0",
  "main": "index.js",
  "reva": ">=0.3.0",
  "contributes": {
    "commands": [{ "id": "hello", "title": "Hello By Hand: Hello", "keybinding": "Ctrl+Alt+J" }]
  }
}
```

`index.js`:

```js
exports.activate = (reva) => {
  reva.commands.register('hello', () => reva.ui.toast('Hi from a hand-made plugin'));
};
```

Reva notices the new folder by itself. Open *Plugins > Installed*, switch the plugin on and approve the (empty) permission list. Then press **Ctrl+Alt+J** or use the palette.

Install an existing plugin instead: *Install from folder...* or *Install from .zip...* copies it into the user folder (zip: `plugin.json` at the top level or inside one top-level folder). *Install for this project* puts it in `<workspace>\.reva\plugins` so it can live in git.

## Folder layout

```
my-plugin/
  plugin.json          required: id, name, version + contributions + permissions
  index.js             "main": runs in the renderer; exports.activate(reva)
  themes/night.json    files referenced from contributes (themes, snippets, language configuration)
  snippets.json
  README.md            optional
```

Every file path in `plugin.json` is relative to the plugin folder and must stay inside it. `node_modules` and `.git` are ignored by the watcher and by installs. A plugin is limited to 100 MB, `main` to 4 MB.

## What the code can and cannot do

- **It runs in the renderer** (the browser side of Electron), as a plain script: `exports.activate = (reva) => {...}`. The CommonJS-looking `exports` and `module` objects exist, but **`require` and `import` do not work** (`require('fs')` fails with *Check dependency list! Synchronous require cannot resolve module 'fs'*). Use the `reva` API, and `reva.fetch` for the network.
- The `reva` object is also available as a free variable at the top level of your script.
- Everything you register through `reva.*` is removed when the plugin is disabled, reloaded or uninstalled. **Timers (`setInterval`), DOM listeners you attach yourself, and globals are not** - clean them up in `exports.deactivate`.
- Use vanilla JavaScript (async/await, classes, optional chaining are fine). No framework is loaded.

## Hot reload

A watcher observes `%APPDATA%\Reva\plugins` and `<workspace>\.reva\plugins`. When a file inside a plugin folder changes, that plugin is deactivated, everything it registered is disposed and `activate` runs again, usually within 0.6 s. A broken `plugin.json` turns the plugin **Invalid** until you fix it (the enabled state is remembered). Notes:

- Folders starting with `.`, `node_modules` and `.git` are ignored; so are changes in the first ~1 s after Reva itself installs or creates a plugin.
- Turn on **Developer mode** (switch at the bottom of *Plugins > Installed*) to get a toast on every reload.
- *Reload all* in the manager, or the palette command *Plugins: Reload All*, restarts every plugin.

## The log console

Everything a plugin logs is kept (the last 500 lines) and shown at *Plugins > Installed > Details > Log*. Inside a plugin:

```js
reva.log.info('count', 3, { a: 1 });   // objects are JSON-stringified, Error objects show their stack
reva.log.warn('careful');
reva.log.error(new Error('boom'));
console.log('same as reva.log.info');  // console.* is redirected into the plugin log
```

With **Developer mode** on, a **Console** tab shows the logs of all plugins together (filter by plugin) and every line is also printed to DevTools (`[plugin my-plugin] ...`). Errors are always printed to DevTools.

## Debugging tips

- **DevTools:** press **F12**. Your script appears as `reva-plugin://<id>/index.js`; put `debugger;` in it to stop there.
- **Poke at the live `reva` object** from the DevTools console by exposing it while developing: `window.dbg = reva;` in `activate`, then type `dbg.workspace.root`, `await dbg.workspace.search('TODO')`, ...
- **Inspect the system:** in the DevTools console, `RevaPlugins.list()` (status, errors, permissions), `RevaPlugins.logs('my-plugin')`, `RevaPlugins._debug()` (registered commands, panels, tools, hooks), `RevaPlugins.reloadPlugin('my-plugin')`.
- **Status meanings:** `active` running; `idle` enabled, waiting for its activation event; `disabled`; `needs-approval` (permissions not granted yet); `invalid` (manifest errors); `error` (activation failed or auto-disabled).
- **Errors are isolated.** An exception in a command, hook or panel is logged and shown once as a toast; it never breaks Reva. After **5 consecutive** callback errors the plugin is disabled automatically (re-enable it in the manager). Any successful callback resets the counter.
- **An `await` that never finishes** in `activate` is cut off after 20 s (`activate() did not finish within 20 s`); a warning appears after 5 s.
- Check the permissions first when an API throws: the message names the missing one.

## Test a plugin without clicking (for developers and AI agents)

When you run Reva from source you can install and exercise a plugin from the command line with the screenshot harness. It uses a throw-away profile (`%TEMP%\reva-shot`), never your real data. The window is invisible; the script runs in the renderer.

`test-plugin.js` (adjust the path to your plugin; the script result is printed):

```js
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dir = 'C:\\path\\to\\my-plugin';
  const r = await RevaPlugins.install(dir, { overwrite: true });          // copies to the profile's plugins folder
  if (!r.ok) return 'INSTALL FAILED: ' + r.error;
  await RevaPlugins.enable(r.id, { confirm: true, skipDialog: true });    // grants the permissions without the dialog
  await sleep(500);
  await RevaPlugins.executeCommand(r.id + '.hello');                      // run a command of the plugin
  const p = RevaPlugins.get(r.id);
  return JSON.stringify({ status: p.status, errors: p.errors, logs: RevaPlugins.logs(r.id).map((l) => l.level + ': ' + l.msg) }, null, 1);
})()
```

Run it (PowerShell). Electron is a GUI program, so redirect its output to see the result:

```powershell
$app = 'C:\path\to\Reva'                       # the folder with package.json and src\
$p = Start-Process "$app\node_modules\electron\dist\electron.exe" -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput out.txt -RedirectStandardError err.txt `
  -ArgumentList "`"$app`"", '--shot', 'shot.png', '--wait', '4000', '--eval', '@C:\path\to\test-plugin.js'
$p.WaitForExit(60000) | Out-Null; Get-Content out.txt
```

`out.txt` contains `eval result: {...}` and every renderer error. `shot.png` is a screenshot taken after the script. Tips: inject `document.head.append(Object.assign(document.createElement('style'),{textContent:'*{animation:none!important}'}))` and `await sleep(1200)` before the end of your script for a clean capture; open a folder with `await App.setWorkspace('C:\\path\\to\\project')`; open a file with `await window.openFile(path)`. Stop only the Electron process you started (`$p.Kill()`), because you may have the real Reva open.

Useful helpers inside the script: `RevaPlugins.install/enable/disable/uninstall/reloadPlugin/get/list/logs`, `RevaPlugins.executeCommand(fullId, ...args)`, `RevaPlugins.beforeSend(text, {id})` (runs slash commands), `await IDE.exec('<id>__<tool>', args)` (calls a plugin agent tool exactly as an agent would), `RevaPlugins.explorerMenuItems(path, isDir)`, `RevaPlugins.paletteItems()`.

## Common errors

Messages are shown in the plugin card (red), in toasts and in the log, exactly as written here.

### Installing and scanning

| Message | Cause and fix |
| --- | --- |
| `plugin.json not found in <dir>` | The folder has no `plugin.json`. A `.zip` must have it at the top level or in a single top-level folder: `No plugin.json found at the top level of the zip (or in a single top-level folder)`. |
| `plugin.json is not valid JSON: ...` | Syntax error: trailing comma, single quotes, comments. |
| `"id" is required (e.g. "my-plugin")` | Add an `id`. |
| `"id" must be 2-40 chars of lowercase letters/digits separated by single hyphens (got "My_Plugin")` | Use `my-plugin`. |
| `"version" must look like 1.2.3 (got "1.0")` | Three numbers: `1.0.0`. |
| `"main" file not found: index.js` | The file named in `main` does not exist. Remove `main` for declarative plugins. |
| `"main" must stay inside the plugin folder (got "../x.js")` | No `..` paths. |
| `unknown permission "x" (known: workspace.read, ...)` | Typo in `permissions`. |
| `unknown activation event "x" (use onStartup, onWorkspace, onCommand:<id>, onFileType:<ext>)` | Fix `activation`. |
| `contributes.agentTools requires the "agents" permission` / `contributes.slashCommands requires the "chat" permission` | Add the permission. |
| `requires Reva >=9.0.0 but this is Reva 0.4.0` | Lower the `reva` range. |
| `A plugin with id "x" is already installed` | Install again with *Replace* (the UI asks), or uninstall first. |
| `id "x" collides with the plugin in <dir>` | A user plugin and a project plugin share an id. Rename one. |
| `Unsafe path in zip (path traversal rejected): "../evil.txt"` | The archive contains `..` or absolute paths; Reva refuses it. Re-zip the plugin folder. |
| `Not a valid .zip file (end-of-central-directory record not found)` | Not a zip. Reva reads store/deflate zips without encryption, zip64 or symlinks. |
| `Open a folder first to install a project plugin` | *Install for this project* needs an open folder. |

The full list of manifest messages is in [manifest.md](manifest.md#validation-errors).

### Running

| Message | Cause and fix |
| --- | --- |
| `Plugin “x” needs the "workspace.read" permission to read files. Add "workspace.read" to "permissions" in its plugin.json and approve it again.` | Declare the permission in `plugin.json`; the manager shows **Needs approval** - click *Review...*. |
| `Plugin “x” failed to start: Unexpected token ...` | Syntax error in `index.js`; the log has the line. |
| `Check dependency list! Synchronous require cannot resolve module 'fs'...` | You used `require`. There is none: use the `reva` API. |
| `activate() did not finish within 20 s` | An awaited promise never resolves in `activate`. Register things first, load data afterwards without blocking. |
| `Disabled automatically after 5 consecutive errors. Last: ...` | A callback keeps throwing. Fix it, then re-enable the plugin. |
| `Unknown command: x.y` | The command id is not registered (typo, or the plugin is not enabled / failed to start). Full id = `<pluginId>.<id>`. |
| `Command "x.y" is already registered by plugin "z"` | Two plugins registered the same full id. |
| `No editor is open` / `No workspace folder is open` | Guard for `reva.editor.activeFile()` returning `null` and for `reva.workspace.root` being `null`. |
| `ENOENT: no such file or directory, stat '...'` | `reva.workspace.readFile` of a missing file (relative paths resolve against the workspace root). |
| `Blocked: 127.0.0.1 is on a private/local network (needs the "network.local" permission)` | `reva.fetch` to localhost or a LAN address needs **both** `network` and `network.local`. |
| `Plugin storage is limited to 1024 KB` | `reva.storage` holds 1 MB per plugin. |
| `Unsupported keybinding "Ctrl+Foo"` | Use `Ctrl`/`Shift`/`Alt` plus a letter, digit, `F1`-`F12`, `Enter`, `Space`, `Tab`, `Esc`, `Up`... |
| `registerTool: "name" must be letters, digits and underscores (got "x")` | See [agent-tools.md](agent-tools.md#rules-for-tools). |
| `Illegal value for token color: #111` (red errors in DevTools) | A theme colour is not 6-digit hex: use `#111111` in `v`, and `rrggbb` (no `#`) in `t`. |

## Next steps

- Copy a recipe from the [cookbook](cookbook.md).
- Look up an API in [api.md](api.md); every function has a runnable example.
- Give your agents a new tool: [agent-tools.md](agent-tools.md).
- Autocomplete in your editor: add `/// <reference path="reva.d.ts" />` and `// @ts-check` to `index.js` ([reva.d.ts](reva.d.ts)), and `"$schema": "./plugin.schema.json"` to `plugin.json` ([plugin.schema.json](plugin.schema.json)).
