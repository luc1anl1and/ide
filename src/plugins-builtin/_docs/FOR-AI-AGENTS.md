# Reva plugin spec for AI agents

You are asked to write a plugin for **Reva** (Electron IDE). Read this whole file, then write the plugin. Full docs, if needed: `docs/extensions/` of the Reva repo (`api.md`, `manifest.md`, `cookbook.md`, `agent-tools.md`).

## Hard rules

1. A plugin is a **folder** containing `plugin.json` and (usually) `index.js`. Write the files into the plugin folder you were given. Never modify Reva's own source files.
2. `index.js` runs **in the renderer** as a plain script: **vanilla JavaScript only**. No `require`, no `import`, no TypeScript, no npm packages, no bundler. (`require('fs')` fails.) Entry point: `exports.activate = (reva) => { ... }` (may be `async`). Optional `exports.deactivate = () => {}`.
3. Use ONLY the `reva` object (`reva.commands`, `reva.ui`, `reva.editor`, `reva.workspace`, `reva.chat`, `reva.agents`, `reva.terminal`, `reva.preview`, `reva.settings`, `reva.storage`, `reva.theme`, `reva.events`, `reva.log`, `reva.fetch`). Do not touch `window`, `document` internals, or Reva globals (`A`, `api`, `RevaPlugins`), except plain DOM inside your own panel container.
4. **Declare every permission you use** in `plugin.json` `"permissions"` (table below). A missing permission throws at runtime.
5. Declare what you contribute in `plugin.json` `"contributes"` AND register the behaviour in code (a declared command needs `reva.commands.register(sameId, fn)`; a declared tool needs `reva.agents.registerTool`).
6. Everything registered through `reva.*` is removed automatically on reload/disable. **Timers, `document`/`window` listeners and connections are not**: clear them in `exports.deactivate`.
7. Files named in `plugin.json` are relative to the plugin folder and must exist. Theme colours: `v` values `#rrggbb` (exactly 6 digits), `t` values `rrggbb` (no `#`).
8. Windows environment: absolute paths look like `C:\x\y`; relative paths in the API may use `/`. JSON read from disk can start with a BOM: `text.replace(/^\uFEFF/, '')` before `JSON.parse`.
9. Guard for missing state: `reva.workspace.root` may be `null`; `reva.editor.activeFile()` may be `null`.

## plugin.json skeleton

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What it does.",
  "main": "index.js",
  "reva": ">=0.3.0",
  "activation": ["onStartup"],
  "permissions": [],
  "contributes": {
    "commands": [{ "id": "run", "title": "My Plugin: Run", "keybinding": "Ctrl+Alt+M" }]
  }
}
```

- `id`: 2-40 chars, lowercase letters/digits separated by single hyphens (must equal the folder name). `version`: `1.2.3`. `main`: omit for declarative plugins (themes, snippets, languages).
- `activation` (default `["onStartup"]`): also `onWorkspace`, `onCommand:<id>`, `onFileType:.ext`.
- `contributes` keys (all arrays): `commands {id,title,keybinding?}`, `sidebarPanels {id,title,icon?}`, `statusBar {id,align?: left|right,text?,tooltip?,icon?,command?}`, `themes {id,name,file}`, `snippets {language,file}` (VS Code snippet JSON), `languages {id,extensions[],aliases?,configuration?: file|object}`, `settings {key,title,type: boolean|string|text|number|select|color,default,description?,options? (select),min?,max?,step?}`, `slashCommands {name,description?}` (needs `chat`), `agentTools {name,description,inputSchema?,readOnly?}` (needs `agents`), `fileActions {id,title,when?:{extensions[]}}` (`id` = a command id; it receives the file path); `menus {"explorer/context"|"editor/context"|"commandPalette": [{command,title?,when?}]}`.
- Icon names: `plug sparkle code list palette agent chat edit gauge bolt globe term search folder file eye gear history refresh check warn play`.

## Permissions

| Permission | Needed for |
| --- | --- |
| `workspace.read` | `editor.activeFile/openFiles`, `workspace.readFile/listDir/exists/findFiles/search/watch/onDidChange/onDidOpen` |
| `workspace.write` | `workspace.writeFile`, `editor.insertText/replaceSelection/setText/registerFormatter/format` |
| `terminal` | `terminal.run/read` |
| `network` / `network.local` | `fetch` (public) / also localhost and private IPs (declare both) |
| `chat` | everything in `reva.chat`, `slashCommands` |
| `agents` | `agents.registerTool`, `agentTools` |
| `preview` | `preview.open/screenshot/console` |
| `settings` | `settings.app.get/set`, `theme.apply` |

No permission: `commands`, `ui`, `settings.get/set/all`, `storage`, `theme.register`, `events`, `log`, `editor.openFile/registerAction/on*/decorate/registerTokenizer/registerLanguage/registerCompletionProvider/registerHoverProvider/registerSnippets`.

## API cheat sheet

```js
// commands: id is local; full id = "<pluginId>.<id>"
reva.commands.register(id, (...args) => any, { title?, keybinding? })   // -> Disposable
await reva.commands.execute(id, ...args);  reva.commands.list();

// ui
reva.ui.toast(msg, 'error'?);   await reva.ui.confirm(title, text, { okLabel?, danger? })  // -> boolean
await reva.ui.prompt(title, { value?, placeholder? })                   // -> string | null (cancel)
await reva.ui.quickPick(['a', { label, description?, value? }], { title? })  // -> value | undefined
reva.ui.openPanelModal({ title, width?: 'wide', render(body, { close }) })
const panel = reva.ui.addSidebarPanel({ id, title, icon?, render(container, ctx) {} })  // panel.refresh() panel.show()
const item = reva.ui.addStatusItem({ id, align?, text, tooltip?, icon?, onClick? })     // item.update({ text, tooltip, icon })
reva.ui.addTitleBarButton({ icon, title, onClick });  reva.ui.h('div', { class, style: {}, onclick }, ...children);  reva.ui.icon(name)

// editor (callbacks get file info WITHOUT text; call activeFile() for text)
reva.editor.activeFile()   // { path, name, language, text, selection: { text, empty, startLine, ... }, line, column } | null
reva.editor.openFiles();  await reva.editor.openFile(path, line?);
reva.editor.insertText(t); reva.editor.replaceSelection(t); reva.editor.setText(t)   // throw 'No editor is open'
reva.editor.registerAction({ id, label, keybinding?, run(file) });  reva.editor.format()
reva.editor.onDidSave(path => {}); onWillSave(({ path, language, isActive }) => {}); onDidChangeActive(f => {}); onDidChangeText(f => {}); onDidChangeSelection(f => {})
reva.editor.decorate([{ line, background?, color?, underline?, message? }])   // -> { set(items), clear() }
reva.editor.registerTokenizer(lang, monarchDef); registerHoverProvider(lang, ({ word, lineText }) => string | null)
reva.editor.registerCompletionProvider(lang, { triggerCharacters?, provideCompletionItems(ctx) { return [{ label, kind?, detail?, insertText?, snippet? }]; } })
reva.editor.registerSnippets(lang, { name: { prefix, body, description } });  registerFormatter(lang, (text, ctx) => newText)

// workspace (paths: absolute or relative to the open folder)
reva.workspace.root;  await readFile(p) -> string;  await writeFile(p, text);  await listDir(p) -> [{ name, dir, path }];  await exists(p)
await reva.workspace.findFiles('**/*.{js,ts}', { max? }) -> absolute paths;  await search('text', { max? }) -> [{ file, line, text }]  // line 0 = file-name hit
reva.workspace.watch(glob, paths => {}); onDidChange(paths => {}); onDidOpen(root => {})

// chat (permission "chat")
reva.chat.send(text, { agent?: 'claude'|'codex'|'opencode' });  insert(text);  newChat({ agent? })
reva.chat.registerSlashCommand({ name, description, run(args, ctx) { return 'text sent instead' /* or nothing = send nothing */; } })
reva.chat.onBeforeSend((text, ctx) => string | false | undefined);  onAgentEvent(ev => {})   // ev.type: text|tool_use|tool_result|result|error

// agent tools (permission "agents"): agents see "<pluginId>__<name>"; new chat needed to see changes
reva.agents.registerTool({ name, description, inputSchema, readOnly?, handler: async (args) => string | { text, isError? } | { image } | any JSON })   // throw = error result

reva.terminal.run(cmd, { newTab? });  reva.terminal.read(lines?)
await reva.preview.open({ url | file });  await reva.preview.screenshot();  await reva.preview.console({ level? })
reva.settings.get(key, fallback?);  set(key, v);  all();  onDidChange((key, v) => {});  reva.settings.app.get/set(key)
await reva.storage.get(key, fallback?);  set(key, v);  delete(key);  keys()          // 1 MB per plugin
reva.theme.register({ name, dark, v: {...}, t: {...} }, id?);  reva.theme.apply(id)
reva.events.on(name, (data, fromId) => {});  once(...);  emit(name, data)
reva.log.info/warn/error/debug(...)         // visible in Plugins > the plugin > Log
const res = await reva.fetch(url, { method?, headers?, body? (object => JSON), timeout? })   // { ok, status, headers.get(), text(), json() }
reva.id; reva.version; reva.platform; reva.pluginDir; reva.manifest
```
Every registration returns a Disposable (`.dispose()`), never required. Callback exceptions are caught and logged; 5 in a row disable the plugin.

## How to test and iterate

1. **Hot reload:** Reva reloads the plugin whenever a file in its folder is saved (about 0.6 s). Do not restart Reva. A syntax error shows as an error status with the message in the plugin log (Plugins manager `Ctrl+Shift+X` > the plugin > Details > Log).
2. **Check and run:** `node --check index.js` in the plugin folder; run a command from the palette (`Ctrl+Shift+P`), open the panel, or (agent tools) start a **new** chat and call `<pluginId>__<tool>`.
3. **Headless test (when Reva runs from source):** install and exercise the plugin with the screenshot harness. Electron is a GUI app: redirect stdout.

```powershell
$app = 'C:\path\to\Reva'
$p = Start-Process "$app\node_modules\electron\dist\electron.exe" -PassThru -WindowStyle Hidden -RedirectStandardOutput out.txt -RedirectStandardError err.txt `
  -ArgumentList "`"$app`"", '--shot', 'shot.png', '--wait', '4000', '--eval', '@C:\path\to\test.js'
$p.WaitForExit(60000) | Out-Null; Get-Content out.txt      # prints "eval result: ..." and renderer errors
```

`test.js` (renderer code; it uses a temp profile, not the user's data):

```js
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const r = await RevaPlugins.install('C:\\path\\to\\my-plugin', { overwrite: true });
  if (!r.ok) return 'INSTALL FAILED: ' + r.error;
  await RevaPlugins.enable(r.id, { confirm: true, skipDialog: true });
  await sleep(500);
  await RevaPlugins.executeCommand(r.id + '.run');                    // a command
  // await IDE.exec(r.id + '__my_tool', { arg: 1 });                  // an agent tool, as an agent would call it
  const p = RevaPlugins.get(r.id);
  return JSON.stringify({ status: p.status, errors: p.errors, logs: RevaPlugins.logs(r.id).map((l) => l.level + ': ' + l.msg) });
})()
```

Expect `status: "active"` (or `"idle"` for lazy activation), `errors: []` and no `error:` log lines. Kill only the Electron process you started (the user may have Reva open).

## Example 1: command + picker (workspace.read)

`plugin.json`
```json
{
  "id": "todo-picker",
  "name": "TODO Picker",
  "version": "1.0.0",
  "description": "Command that lists TODO/FIXME comments and jumps to the one you pick.",
  "main": "index.js",
  "reva": ">=0.3.0",
  "permissions": ["workspace.read"],
  "contributes": { "commands": [{ "id": "scan", "title": "TODO Picker: Find TODOs" }] }
}
```

`index.js`
```js
exports.activate = (reva) => {
  reva.commands.register('scan', async () => {
    const hits = [...await reva.workspace.search('TODO', { max: 200 }), ...await reva.workspace.search('FIXME', { max: 200 })]
      .filter((x) => /\b(TODO|FIXME)\b/.test(x.text));
    if (!hits.length) return reva.ui.toast('No TODO or FIXME found');
    const rel = (p) => p.slice(reva.workspace.root.length + 1);
    const pick = await reva.ui.quickPick(
      hits.map((x) => ({ label: x.text.trim(), description: rel(x.file) + ':' + x.line, value: x })),
      { title: hits.length + ' TODO/FIXME comments' });
    if (pick) await reva.editor.openFile(pick.file, pick.line);
  });
};
```

## Example 2: sidebar panel (workspace.read)

`plugin.json`
```json
{
  "id": "open-files",
  "name": "Open Files",
  "version": "1.0.0",
  "main": "index.js",
  "reva": ">=0.3.0",
  "permissions": ["workspace.read"],
  "contributes": { "sidebarPanels": [{ "id": "list", "title": "Open Files", "icon": "file" }] }
}
```

`index.js`
```js
exports.activate = (reva) => {
  const { h } = reva.ui;
  const panel = reva.ui.addSidebarPanel({
    id: 'list', title: 'Open Files', icon: 'file',
    render(box) {
      const files = reva.editor.openFiles();
      box.replaceChildren(...(files.length ? files : [null]).map((p) => p
        ? h('div', { class: 'res', style: { cursor: 'pointer' }, onclick: () => reva.editor.openFile(p) }, p.split('\\').pop())
        : h('div', { class: 'empty' }, 'No files open')));
    },
  });
  reva.editor.onDidChangeActive(() => panel.refresh());   // refresh() does nothing while the panel is hidden
};
```

## Example 3: agent tool (agents, workspace.read)

`plugin.json`
```json
{
  "id": "npm-scripts",
  "name": "npm Scripts",
  "version": "1.0.0",
  "description": "Gives agents a read-only tool that lists the npm scripts of the open project.",
  "main": "index.js",
  "reva": ">=0.3.0",
  "permissions": ["agents", "workspace.read"],
  "contributes": {
    "agentTools": [{
      "name": "list_scripts",
      "description": "Lists the scripts in the open project's package.json (name and command). Call before guessing how to build, test or start the project.",
      "inputSchema": { "type": "object", "properties": { "package": { "type": "string", "description": "Relative folder of a sub-package (default: workspace root)" } } },
      "readOnly": true
    }]
  }
}
```

`index.js`
```js
exports.activate = (reva) => {
  reva.agents.registerTool({
    name: 'list_scripts',
    description: "Lists the scripts in the open project's package.json (name and command). Call before guessing how to build, test or start the project.",
    inputSchema: { type: 'object', properties: { package: { type: 'string', description: 'Relative folder of a sub-package (default: workspace root)' } } },
    readOnly: true,
    handler: async ({ package: dir = '.' }) => {
      if (!reva.workspace.root) throw new Error('No workspace folder is open');
      const raw = await reva.workspace.readFile(dir.replace(/\/$/, '') + '/package.json');
      const pkg = JSON.parse(raw.replace(/^\uFEFF/, ''));   // Windows editors often write a BOM
      const lines = Object.entries(pkg.scripts || {}).map(([k, v]) => `${k}: ${v}`);
      return lines.length ? `${pkg.name || '(unnamed)'}\n` + lines.join('\n') : 'No scripts in package.json';
    },
  });
};
```

## Before you finish

- [ ] `plugin.json` is valid, `id` = folder name, every permission used is declared, every declared command/tool/panel is registered in code, no `require`/`import`, timers cleared in `deactivate`, null checks done.
- [ ] Saved (hot reload) and the plugin log shows `activated` with no errors.
- [ ] Told the user how to use it: palette command title, shortcut, where the panel/status item is, or the tool name (`<pluginId>__<name>`, new chat).