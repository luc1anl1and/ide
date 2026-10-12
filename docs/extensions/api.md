# The `reva` API

Your plugin's `index.js` receives one object, `reva`, in `exports.activate(reva)`. It is also available as a free variable in the whole script. Everything is per plugin: what you register is owned by the plugin and removed when it stops.

Conventions in this reference:

- **Perm** = the permission that must be in `permissions` (and approved). `-` means none. Without it the call throws `Plugin “<id>” needs the "<perm>" permission to <what>. Add "<perm>" to "permissions" in its plugin.json and approve it again.`
- A **Disposable** is `{ dispose() }`. Calling `dispose()` unregisters that one thing early; you never have to call it, Reva disposes everything on deactivate.
- Paths are Windows paths. `workspace` functions accept absolute paths or paths relative to the open folder (forward slashes are fine).
- Callbacks you give to `reva.*` are wrapped: an exception is logged, shown once as a toast, counted, and **never propagates** into Reva (see [error isolation](#error-isolation-and-timeouts)).
- Every example below is complete code for the body of `activate` unless it says otherwise, and was run against Reva 0.4.0.

| Namespace | Purpose |
| --- | --- |
| [Lifecycle](#lifecycle) | `activate`, `deactivate`, disposables, errors, timeouts |
| [Misc properties](#misc-properties) | `id`, `version`, `platform`, `pluginDir`, `manifest` |
| [`reva.commands`](#revacommands) | commands and shortcuts |
| [`reva.ui`](#revaui) | toasts, dialogs, pickers, sidebar panels, status bar, title bar |
| [`reva.editor`](#revaeditor) | active file, edits, actions, hooks, languages, formatters |
| [`reva.workspace`](#revaworkspace) | files, search, watchers |
| [`reva.chat`](#revachat) | send/insert messages, slash commands, hooks |
| [`reva.agents`](#revaagents) | tools for Claude, Codex, OpenCode |
| [`reva.terminal`](#revaterminal) | run commands, read output |
| [`reva.preview`](#revapreview) | browser preview |
| [`reva.settings`](#revasettings) | your plugin's settings, Reva's settings |
| [`reva.storage`](#revastorage) | persistent key/value |
| [`reva.theme`](#revatheme) | register and apply themes |
| [`reva.events`](#revaevents) | cross-plugin event bus |
| [`reva.log`](#revalog) | logging |
| [`reva.fetch`](#revafetch) | HTTP requests |

## Lifecycle

```js
exports.activate = async (reva) => { /* register things */ };
exports.deactivate = async () => { /* optional: clear timers, close connections */ };
```

- Reva evaluates your `main` file once per start as a function body: `new Function('reva', 'module', 'exports', 'console', code)`. `this` is `exports`; you may also assign `module.exports = { activate, deactivate }`. `console.log/info/warn/error/debug` write to the plugin log.
- `activate(reva)` runs when an [activation event](manifest.md#activation-events) fires. It may be `async`. It must finish within **20 s** (a warning is logged after 5 s); otherwise the plugin fails with `activate() did not finish within 20 s`. If it throws, the plugin status becomes `error`, a toast shows `Plugin “<name>” failed to start: <message>` and everything it already registered is disposed.
- `deactivate()` runs when the plugin is disabled, reloaded (hot reload), or uninstalled, **before** the automatic clean-up. It may be async; it is cut off after **3 s**.
- **Automatic clean-up** disposes, in reverse order, everything registered through `reva.*`: commands, panels, status items, title bar buttons, actions, hooks, providers, decorations, tools, slash commands, events, themes. **Not cleaned up:** your own `setInterval`/`setTimeout`, DOM listeners you added to `document`/`window`, network connections, globals. Clear them in `deactivate`.
- A plugin script has no `require`/`import`; vanilla JavaScript only.

```js
// Minimal complete plugin with proper clean-up
let timer;
exports.activate = (reva) => {
  const item = reva.ui.addStatusItem({ id: 'tick', align: 'right', text: '0' });
  let n = 0;
  timer = setInterval(() => item.update({ text: String(++n) }), 1000);
};
exports.deactivate = () => clearInterval(timer);
```

### Error isolation and timeouts

| Situation | Behaviour |
| --- | --- |
| Exception in a command, hook, panel render, status click, slash command, tool handler, ... | logged (`error: [command my-plugin.run] Error: ...`), one toast per activation, error counter +1, Reva keeps working |
| 5 consecutive failures (any successful callback resets the counter) | plugin is **auto-disabled**: status `error`, toast `Plugin “x” was disabled: Disabled automatically after 5 consecutive errors. Last: ...`, everything it registered is removed. Re-enable it in the manager. |
| `activate()` throws / rejects / times out | status `error`, contributions disposed, toast `failed to start` |
| `deactivate()` slower than 3 s or throws | warning in the log, clean-up continues |
| `onWillSave` handler slower than 5 s | skipped, the file is saved anyway |
| Agent tool handler throws | the agent receives `Error: <message>` with `isError: true`; counts as a plugin error |
| Agent tool call, whole round trip | 25 s limit in the MCP server |
| `reva.fetch` | 20 s default (`timeout` option up to 60 s) |

### Disposables

```js
exports.activate = (reva) => {
  const d = reva.commands.register('temp', () => reva.ui.toast('temporary'));
  reva.commands.register('remove-temp', () => { d.dispose(); reva.ui.toast('removed'); });
};
```

## Misc properties

| Property | Type | Value |
| --- | --- | --- |
| `reva.id` | string | the plugin id |
| `reva.version` | string | the Reva app version, e.g. `"0.4.0"` |
| `reva.platform` | string | `process.platform` of Reva (`"win32"`) |
| `reva.pluginDir` | string | absolute path of the plugin folder |
| `reva.manifest` | object | deep copy of the validated `plugin.json` (arrays normalised to `[]`, `activation` defaulted) |

```js
exports.activate = (reva) => {
  reva.log.info(reva.id, 'on Reva', reva.version, reva.platform, 'in', reva.pluginDir);
  reva.log.info('permissions:', reva.manifest.permissions, 'activation:', reva.manifest.activation);
};
```

## reva.commands

### `register(id, fn, meta?)` -> Disposable

Registers the handler of a command. `id` becomes `<pluginId>.<id>` (an id that already starts with `<pluginId>.` is kept). Declare the command in `contributes.commands` to give it a palette title and shortcut; or pass `meta = { title, keybinding }` to add a palette entry from code. Perm: -.

| Param | Type | Notes |
| --- | --- | --- |
| `id` | string | local id |
| `fn` | `(...args) => any` | return value is what `execute` resolves to |
| `meta` | `{ title?, keybinding? }` | optional |

Errors: `Command "<full id>" is already registered by plugin "<other>"`. A throwing `fn` is isolated (logged, `execute` resolves `undefined`).

```js
exports.activate = (reva) => {
  reva.commands.register('add', (a, b) => a + b, { title: 'Demo: Add' });
  reva.commands.register('shout', async (text = 'hi') => reva.ui.toast(text.toUpperCase()));
};
```

### `execute(id, ...args)` -> Promise&lt;any&gt;

Runs a command. A bare id (`add`) means your own; use the full id (`other-plugin.run`, or a built-in plugin command) for others. Plugins waiting on `onCommand:<id>` are started first. Rejects with `Unknown command: <id>`. Perm: -.

```js
exports.activate = (reva) => {
  reva.commands.register('add', (a, b) => a + b);
  reva.commands.register('demo', async () => {
    const sum = await reva.commands.execute('add', 2, 3);   // 5
    reva.ui.toast('2 + 3 = ' + sum);
  });
};
```

### `list()` -> string[]

Full ids of all commands registered by code right now (all plugins). Declared-but-not-started commands are not included. Perm: -.

```js
exports.activate = (reva) => {
  reva.commands.register('x', () => 1);
  reva.log.info(reva.commands.list());   // ["my-plugin.x", ...]
};
```

## reva.ui

### `h(tag, props?, ...children)` -> HTMLElement

Tiny DOM builder. `props`: `class`, `style` (object), `html` (raw innerHTML - never put untrusted text there), `onclick`/`oninput`/... (any `on*`), boolean attributes (`true` sets, `false` skips), anything else becomes an attribute. Children: strings, nodes, arrays (flattened); `null`/`false` are skipped.

```js
exports.activate = (reva) => {
  const { h } = reva.ui;
  const card = h('div', { class: 'u-note', style: { padding: '12px' } },
    h('b', null, 'Hello'), ' ', h('button', { class: 'btn sm', onclick: () => reva.ui.toast('clicked') }, 'Click'));
  reva.ui.addSidebarPanel({ id: 'demo', title: 'Demo', render: (box) => box.replaceChildren(card) });
};
```

Useful built-in classes inside panels: `btn`, `btn sm`, `btn primary`, `u-note` (muted text), `empty` (centred placeholder), `row`, `inp` (input), `mono`.

### `icon(name)` -> string

SVG markup for a built-in icon, for `html` props. Names: `folder folderOpen file image search history plug gear chat term x plus minus panelLeft chev send stop clip refresh bolt edit eye globe list shield help layout copy check trash sparkle chevDown mic music film user download play palette code keyboard info agent pause key external sliders panelRight panelBottom focus folderPlus rotate gauge warn circle checkCircle xCircle`. Unknown names render the `file` icon.

```js
exports.activate = (reva) => {
  reva.ui.addSidebarPanel({ id: 'icons', title: 'Icons', icon: 'sparkle',
    render: (box) => box.replaceChildren(reva.ui.h('div', { html: reva.ui.icon('sparkle') + ' sparkle' })) });
};
```

### `toast(message, kind?)` -> void

Short notification (3 s). `kind`: `'error'` (or `true`) for a red one (6 s). Perm: -.

```js
exports.activate = (reva) => {
  reva.commands.register('toasts', () => { reva.ui.toast('Saved'); reva.ui.toast('Something failed', 'error'); });
};
```

### `confirm(title, text, options?)` -> Promise&lt;boolean&gt;

Modal OK/Cancel. `options`: `{ okLabel = 'OK', danger = false }`. Resolves `true` on OK, `false` on Cancel/Esc/click outside.

```js
exports.activate = (reva) => {
  reva.commands.register('wipe', async () => {
    if (!(await reva.ui.confirm('Delete everything?', 'This cannot be undone.', { okLabel: 'Delete', danger: true }))) return;
    reva.ui.toast('Deleted');
  });
};
```

### `prompt(title, options?)` -> Promise&lt;string | null&gt;

Modal text input. `options`: `{ value = '', placeholder = '' }`. Resolves the text on OK/Enter (may be `''`), `null` on cancel.

```js
exports.activate = (reva) => {
  reva.commands.register('ask', async () => {
    const name = await reva.ui.prompt('Your name?', { value: 'world', placeholder: 'name' });
    if (name) reva.ui.toast('Hello ' + name);
  });
};
```

### `quickPick(items, options?)` -> Promise&lt;any&gt;

Searchable list (like the palette). `items`: strings or `{ label, description?, value? }`; `options`: `{ title?, placeholder? }`. Resolves the picked item's `value` (the label if no `value`) or `undefined` when dismissed. Typing filters on every word of label + description.

```js
exports.activate = (reva) => {
  reva.commands.register('pick', async () => {
    const color = await reva.ui.quickPick([
      { label: 'Red', description: 'warm', value: '#f00' }, { label: 'Blue', description: 'cool', value: '#00f' }, 'Plain string',
    ], { title: 'Pick a colour' });
    if (color) reva.ui.toast('You chose ' + color);
  });
};
```

### `openPanelModal(options)` -> `{ close(), el }`

Opens a modal dialog and calls `options.render(body, { close })`. `options`: `{ title?, width?: 'wide', render }`. Returns immediately.

```js
exports.activate = (reva) => {
  reva.commands.register('about', () => {
    reva.ui.openPanelModal({ title: 'About', render: (body, { close }) => {
      body.append(reva.ui.h('p', null, 'Plugin ' + reva.id), reva.ui.h('button', { class: 'btn', onclick: close }, 'Close'));
    } });
  });
};
```

### `addSidebarPanel(def)` -> Disposable &amp; `{ id, refresh(), show() }`

Adds a panel to the left sidebar (an icon button after *Files / Search / Chats / Agents / MCP*). Declare it in `contributes.sidebarPanels` too so the icon exists before the plugin starts. Perm: -.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string, required | same id as in the manifest |
| `title` | string | header text |
| `icon` | string | icon name (default `list`) |
| `render(container, ctx)` | function, required | fill `container`; may be async. Called **every time** the panel is shown or refreshed. `ctx = { refresh(), workspace }` |

Returns a Disposable plus `refresh()` (re-renders; returns `undefined` when the panel is not on screen), `show()` (switches the sidebar to it) and `id` (`plugin:<pluginId>:<id>`). Error: `addSidebarPanel needs {id, title, render(container, ctx)}`.

```js
exports.activate = (reva) => {
  const { h } = reva.ui;
  const panel = reva.ui.addSidebarPanel({
    id: 'clock', title: 'Clock', icon: 'history',
    render(box) {
      box.replaceChildren(h('div', { style: { padding: '14px' } }, new Date().toLocaleTimeString(),
        h('button', { class: 'btn sm', style: { marginLeft: '8px' }, onclick: () => panel.refresh() }, 'Refresh')));
    },
  });
  reva.commands.register('show', () => panel.show());
};
```

### `addStatusItem(def)` -> Disposable &amp; `{ update(patch) }`

An item in the status bar. `def`: `{ id (required), align: 'left' | 'right', text, tooltip, icon, onClick }`. An item with the same `id` as a declared `contributes.statusBar` entry replaces it. `update({ text, tooltip, icon, align, onClick })` changes it later; an item with empty `text` and no `icon` is hidden. Error: `addStatusItem needs {id, align, text}`.

```js
exports.activate = (reva) => {
  let n = 0;
  const item = reva.ui.addStatusItem({ id: 'clicks', align: 'right', icon: 'bolt', text: '0 clicks',
    tooltip: 'Click me', onClick: () => item.update({ text: ++n + ' clicks' }) });
};
```

### `addTitleBarButton(def)` -> Disposable

An icon button in the title bar. `def`: `{ icon (name or an `<svg>` string), title, onClick }`. Error: `addTitleBarButton needs {icon, title, onClick}`.

```js
exports.activate = (reva) => {
  reva.ui.addTitleBarButton({ icon: 'bolt', title: 'Say hi', onClick: () => reva.ui.toast('Hi from the title bar') });
};
```

## reva.editor

### `activeFile()` -> object | null

Perm: `workspace.read`. The focused text file, or `null` (no editor, or a preview/image tab is showing).

```
{ path, name, language, text,
  selection: { text, empty, startLine, startColumn, endLine, endColumn },
  line, column }          // line/column of the cursor, 1-based
```

```js
exports.activate = (reva) => {
  reva.commands.register('info', () => {
    const f = reva.editor.activeFile();
    if (!f) return reva.ui.toast('Open a file first', 'error');
    reva.ui.toast(f.name + ' (' + f.language + '): ' + f.text.split('\n').length + ' lines, cursor ' + f.line + ':' + f.column);
  });
};
```

### `openFiles()` -> string[]

Perm: `workspace.read`. Absolute paths of all open files.

```js
exports.activate = (reva) => reva.commands.register('open-list', () => reva.ui.toast(reva.editor.openFiles().length + ' files open'));
```

### `openFile(path, line?)` -> Promise&lt;void&gt;

Perm: -. Opens a file in the editor (relative paths resolve against the workspace; without a folder: `No workspace folder is open`), optionally revealing a 1-based line.

```js
exports.activate = (reva) => reva.commands.register('open-readme', () => reva.editor.openFile('README.md', 1));
```

### `insertText(text)`, `replaceSelection(text)`, `setText(text)` -> void

Perm: `workspace.write`. Edit the active editor as **one undo step**: insert at the cursor, replace the selection, replace the whole document. Error: `No editor is open`.

```js
exports.activate = (reva) => {
  reva.commands.register('upper', () => {
    const f = reva.editor.activeFile();                 // also needs workspace.read
    if (f && !f.selection.empty) reva.editor.replaceSelection(f.selection.text.toUpperCase());
  });
  reva.commands.register('stamp', () => reva.editor.insertText(new Date().toLocaleString('sv-SE')));
  reva.commands.register('trim', () => { const f = reva.editor.activeFile(); if (f) reva.editor.setText(f.text.replace(/[ \t]+$/gm, '')); });
};
```

### `registerAction(def)` -> Disposable

Perm: -. Adds an action to the editor's right-click menu (and optionally a shortcut). `def`: `{ id, label, keybinding?, contextMenu?: boolean (default true), order?, run(file) }`. `run` gets the same object as `activeFile()` (or `{}` when nothing is open). The id is prefixed with the plugin id. Errors: `registerAction needs {id, label, run}`, `Unsupported keybinding "<x>"`, `Editor is not ready`.

```js
exports.activate = (reva) => {
  reva.editor.registerAction({ id: 'count', label: 'Demo: Count characters', keybinding: 'Ctrl+Alt+Y',
    run: (file) => reva.ui.toast((file.text || '').length + ' characters') });
};
```

### Editor events

Perm: -. Each returns a Disposable.

| Function | Callback | Notes |
| --- | --- | --- |
| `onDidSave(cb)` | `cb(path)` | after the file was written (also fires when a file changes on disk and no save hook is available) |
| `onWillSave(cb)` | `cb({ path, language, isActive })` | **before** writing; may be async (5 s limit); you can edit the text with `setText` when `isActive` (the visible editor) |
| `onDidChangeActive(cb)` | `cb(fileInfo \| null)` | a different file became active |
| `onDidChangeText(cb)` | `cb(fileInfo \| null)` | debounced 120 ms |
| `onDidChangeSelection(cb)` | `cb(fileInfo \| null)` | debounced 100 ms (cursor moves too) |

`fileInfo` is like `activeFile()` **without `text`**; call `activeFile()` when you need the text.

```js
exports.activate = (reva) => {
  const status = reva.ui.addStatusItem({ id: 'pos', align: 'right', text: '' });
  const paint = (f) => status.update({ text: f ? f.name + ' ' + f.line + ':' + f.column : '' });
  reva.editor.onDidChangeActive(paint);
  reva.editor.onDidChangeSelection(paint);
  reva.editor.onDidSave((path) => reva.log.info('saved', path));
};
```

### `decorate(items)` -> Disposable &amp; `{ set(items), clear() }`

Perm: -. Colours lines or ranges in the active editor. Item: `{ line | startLine, endLine?, startColumn?, endColumn?, background?, color?, underline?, border?, inlineClass?, glyph?, message? }` (1-based; without columns the whole line is used; `underline` is a colour for a wavy underline; `message` is the hover text). Decorations belong to the editor's current file; repaint them in `onDidChangeActive`/`onDidChangeText`.

```js
exports.activate = (reva) => {
  const deco = reva.editor.decorate([{ line: 1, background: 'rgba(255,200,0,0.2)', message: 'first line' }]);
  reva.commands.register('clear-deco', () => deco.clear());
  reva.commands.register('mark', () => deco.set([{ line: 2, startColumn: 1, endColumn: 6, underline: 'red', message: 'check this' }]));
};
```

### `registerTokenizer(language, monarch)` -> Disposable

Perm: -. Syntax highlighting with a Monaco [Monarch](https://microsoft.github.io/monaco-editor/monarch.html) definition (`{ tokenizer: { root: [[regex, token], ...] } }`). Token names: `comment`, `string`, `number`, `keyword`, `type`, `identifier`, `operator`, `delimiter`, `variable`. Declare the language in `contributes.languages` (or call `registerLanguage`).

```js
exports.activate = (reva) => {
  reva.editor.registerLanguage({ id: 'logfile', extensions: ['.log2'] });
  reva.editor.registerTokenizer('logfile', { tokenizer: { root: [[/ERROR.*/, 'keyword'], [/WARN.*/, 'number'], [/\d{4}-\d\d-\d\d[ T][\d:]+/, 'comment']] } });
};
```

### `registerLanguage(def)` -> void

Perm: -. `{ id, extensions, aliases?, mimetypes?, configuration? }` (configuration = Monaco language configuration object). Open files with a matching extension switch from plain text. A language can be registered once per `(id, extensions)` per Reva session. Error: `registerLanguage needs {id, extensions}`. Declaring it in `contributes.languages` is usually simpler.

### `registerCompletionProvider(language, provider)` -> Disposable

Perm: -. `provider = { triggerCharacters?: string[], provideCompletionItems(ctx) }`; `ctx = { path, language, word, line, column, linePrefix, text }`. Return an array of `{ label, kind?, detail?, documentation?, insertText?, snippet?: boolean, sortText?, filterText? }`. `kind` is a Monaco kind name in any case (`function`, `keyword`, `variable`, `snippet`, `class`, `property`, ...). With `snippet: true`, `insertText` may use `${1:placeholder}` tab stops. Error: `provider needs provideCompletionItems(ctx)`.

```js
exports.activate = (reva) => {
  reva.editor.registerCompletionProvider('javascript', {
    triggerCharacters: ['.'],
    provideCompletionItems: (ctx) => ctx.linePrefix.endsWith('reva.')
      ? [{ label: 'ui', kind: 'module', detail: 'toasts, dialogs, panels' }, { label: 'log', kind: 'module' }]
      : [{ label: 'logv', kind: 'snippet', insertText: "console.log('${1:x}', ${1:x});", snippet: true, detail: 'log a variable' }],
  });
};
```

### `registerHoverProvider(language, provider)` -> Disposable

Perm: -. `provider` is a function or `{ provideHover(ctx) }`; `ctx = { word, line, column, lineText, path }`. Return a markdown string, `{ contents: [string | { value }] }`, `{ text }`, or `null`.

```js
exports.activate = (reva) => {
  reva.editor.registerHoverProvider('javascript', { provideHover: ({ word }) => (word === 'TODO' ? '**TODO** - finish this later' : null) });
};
```

### `registerSnippets(language, snippets)` -> Disposable

Perm: -. `snippets`: VS Code object `{ "name": { prefix, body, description } }` or an array of `{ prefix, body, description, name }`. `prefix` and `body` may be a string or an array (body array = lines).

```js
exports.activate = (reva) => {
  reva.editor.registerSnippets('javascript', { 'Try/catch': { prefix: 'tryc', body: ['try {', '\t$1', '} catch (e) {', '\t$0', '}'], description: 'try/catch' } });
};
```

### `registerFormatter(language, fn)` -> Disposable

Perm: `workspace.write`. Powers *Format Document*. `fn(text, { language, tabSize, insertSpaces, path })` returns the new text (or `null`/the same text for "no change"); may be async. Errors thrown in `fn` are re-thrown to the editor and counted against the plugin. Registering a formatter for a language that already has one (JSON, JS, CSS, HTML built in) makes the editor ask which to use - prefer your own language or `plaintext`.

```js
exports.activate = (reva) => {
  reva.editor.registerFormatter('plaintext', (text) => text.replace(/[ \t]+$/gm, '').replace(/\n*$/, '\n'));
};
```

### `format()` -> Promise&lt;boolean&gt;

Perm: `workspace.write`. Runs *Format Document* on the visible editor with whatever formatter exists (built-in or yours). `false` when there is no editor.

```js
exports.activate = (reva) => reva.commands.register('fmt', async () => reva.ui.toast((await reva.editor.format()) ? 'Formatted' : 'No editor'));
```

## reva.workspace

### `root` -> string | null

Absolute path of the open folder (a getter).

### `readFile(path)` -> Promise&lt;string&gt;

Perm: `workspace.read`. Text of a file. Rejects for missing files (`ENOENT: no such file or directory, stat '...'`) and for binary or very large files (`Cannot read <path> as text (binary)`). A UTF-8 BOM is **not** stripped: do `text.replace(/^﻿/, '')` before `JSON.parse`.

```js
exports.activate = (reva) => {
  reva.commands.register('pkg', async () => {
    const pkg = JSON.parse((await reva.workspace.readFile('package.json')).replace(/^﻿/, ''));
    reva.ui.toast(pkg.name + ' ' + pkg.version);
  });
};
```

### `writeFile(path, content)` -> Promise&lt;true&gt;

Perm: `workspace.write`. Writes (overwrites) a text file, creating missing parent folders. Rejects with the file system error.

```js
exports.activate = (reva) => {
  reva.commands.register('note', async () => { await reva.workspace.writeFile('notes/today.md', '# ' + new Date().toDateString() + '\n'); reva.ui.toast('written'); });
};
```

### `listDir(path = '.')` -> Promise&lt;{ name, dir, path }[]&gt;

Perm: `workspace.read`. Entries of a folder (`dir` is true for folders; `path` is absolute).

### `exists(path)` -> Promise&lt;boolean&gt;

Perm: `workspace.read`. True for files and folders.

```js
exports.activate = (reva) => {
  reva.commands.register('ls', async () => {
    const entries = await reva.workspace.listDir('.');
    reva.ui.toast(entries.map((e) => e.name + (e.dir ? '/' : '')).join('  '));
    reva.log.info('has package.json:', await reva.workspace.exists('package.json'));
  });
};
```

### `findFiles(glob, options?)` -> Promise&lt;string[]&gt;

Perm: `workspace.read`. Absolute paths of matching files. `options.max` (default 2000). Glob: `*` (no `/`), `**`, `?`, `{a,b}`; a pattern without `/` matches at any depth (`*.md` = `**/*.md`); case-insensitive; matched against the workspace-relative path with `/`. Skips `node_modules .git dist build out .next __pycache__ .venv target .reva`; depth limit 10. Returns `[]` without a workspace.

```js
exports.activate = (reva) => {
  reva.commands.register('md-count', async () => {
    const files = await reva.workspace.findFiles('**/*.{md,mdx}', { max: 500 });
    reva.ui.toast(files.length + ' markdown files');
  });
};
```

### `search(query, options?)` -> Promise&lt;{ file, line, text }[]&gt;

Perm: `workspace.read`. Case-insensitive text search over the workspace done in the main process (fast). It skips `node_modules .git dist build .next out __pycache__ .venv target`, files over 1 MB and binaries, stops at depth 8, and (unlike `findFiles`) does **not** skip `.reva`, so project plugins can show up in results. `options.max` (default 300). `file` is absolute, `line` 1-based, `text` the matching line. File *name* matches can also appear with `line: 0`; filter with `x.line > 0`.

```js
exports.activate = (reva) => {
  reva.commands.register('find-todo', async () => {
    const hits = (await reva.workspace.search('TODO', { max: 100 })).filter((x) => x.line > 0);
    reva.ui.toast(hits.length + ' TODO lines');
  });
};
```

### Watching

Perm: `workspace.read`. Each returns a Disposable.

| Function | Callback |
| --- | --- |
| `watch(glob, cb)` | `cb(paths: string[])` for changed files matching the glob |
| `onDidChange(cb)` | `cb(paths: string[])` for any workspace change |
| `onDidOpen(cb)` | `cb(root)` when a folder is opened |

```js
exports.activate = (reva) => {
  reva.workspace.watch('**/*.json', (paths) => reva.log.info('json changed', paths));
  reva.workspace.onDidOpen((root) => reva.log.info('opened', root));
};
```

## reva.chat

All of `reva.chat` needs the **`chat`** permission.

### `send(text, options?)` -> void

Sends a message to the active chat immediately. `options.agent` (`'claude'`, `'codex'`, `'opencode'`) opens a **new chat** with that agent first. Shows the chat panel.

### `insert(text)` -> void

Puts text in the chat input box without sending (the user reviews and presses Enter).

### `newChat(options?)` -> `{ id }`

Opens a new chat (`options.agent` selects the agent).

```js
exports.activate = (reva) => {
  reva.commands.register('ask-claude', () => reva.chat.send('Summarise the open file in 3 bullets.', { agent: 'claude' }));
  reva.commands.register('draft', () => { reva.chat.newChat(); reva.chat.insert('Review this change: '); });
};
```

### `registerSlashCommand(def)` -> Disposable

Adds `/name` to the chat. Declare it in `contributes.slashCommands` too (autocomplete before start). `def`: `{ name (^[\w-]+$), description, run(args, ctx) }`; `args` is the text after the command (trimmed), `ctx = { chatId, provider, text }` (`text` = the full message). What `run` returns decides what is sent:

| Return | Result |
| --- | --- |
| a string (or `{ text }`) | that text is sent **instead of** what the user typed (a prompt rewrite) |
| nothing / `null` / `false` | handled locally; **nothing is sent**, the input is cleared |
| the function throws | logged and toasted; nothing is sent |
| any other object without `text` | the original message (including `/name`) is sent unchanged |

Error: `registerSlashCommand needs {name, description, run(args, ctx)}`.

```js
exports.activate = (reva) => {
  reva.chat.registerSlashCommand({
    name: 'tests', description: 'Write tests for the open file',
    run: (args) => { const f = reva.editor.activeFile(); return f ? 'Write unit tests for ' + f.path + (args ? '. ' + args : '.') : (reva.ui.toast('Open a file first'), null); },
  });
};
```

### `onBeforeSend(cb)` -> Disposable

`cb(text, { chatId, provider })` runs for every outgoing message (after slash commands are expanded), in registration order. Return `false` to cancel, a string to replace the text, anything else to leave it.

```js
exports.activate = (reva) => {
  reva.chat.onBeforeSend((text) => (/password\s*[:=]/i.test(text) ? (reva.ui.toast('Message blocked: looks like a password', 'error'), false) : undefined));
};
```

### `onAgentEvent(cb)` -> Disposable

`cb(event)` for what the agents do, normalised across Claude/Codex/OpenCode. Every event has `chatId` and `provider`:

| `type` | extra fields |
| --- | --- |
| `text` | `text` (assistant text) |
| `tool_use` | `id`, `name`, `input` |
| `tool_result` | `toolUseId`, `isError`, `content` (text) |
| `result` | `ok`, `text`, `costUsd`, `durationMs` (turn finished) |
| `error` | `text` (stderr output) |

```js
exports.activate = (reva) => {
  reva.chat.onAgentEvent((ev) => { if (ev.type === 'tool_use') reva.log.info(ev.provider, 'called', ev.name, ev.input); });
};
```

## reva.agents

### `registerTool(def)` -> Disposable

Perm: `agents`. Publishes a tool on Reva's MCP server; agents see it as `<pluginId>__<name>`. Full guide, schemas, return formats, approvals and security: [agent-tools.md](agent-tools.md).

| Field | Notes |
| --- | --- |
| `name` | `^[a-zA-Z][a-zA-Z0-9_]{0,40}$` |
| `description` | required; says what it does and when to call it |
| `inputSchema` | JSON Schema, `{ type: 'object', properties, required }` |
| `readOnly` | `true` = no side effects |
| `handler(args)` | async ok; returns a string, `{ text, isError? }`, `{ image, mimeType? }`, `{ content: [...] }`, or any JSON value; throw to report an error |

Errors: `registerTool: "name" must be letters, digits and underscores (got "<x>")`, `registerTool needs a handler(args) function`, `registerTool needs a description (agents read it to decide when to call the tool)`.

```js
exports.activate = (reva) => {
  reva.agents.registerTool({
    name: 'echo', description: 'Echoes text back.', readOnly: true,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async ({ text }) => 'You said: ' + text,
  });
};
```

## reva.terminal

### `run(command, options?)` -> Promise&lt;void&gt;

Perm: `terminal`. Opens the terminal panel and types the command into the active terminal (the user sees it); `options.newTab: true` opens a new tab for it. Does not wait for the command; use `read` afterwards.

### `read(lines = 200, tab?)` -> string

Perm: `terminal`. The last `lines` lines of the active terminal (or terminal tab index `tab`). **Synchronous.**

```js
exports.activate = (reva) => {
  reva.commands.register('serve', async () => {
    await reva.terminal.run('npm run dev', { newTab: true });
    setTimeout(() => reva.log.info(reva.terminal.read(20)), 3000);
  });
};
```

## reva.preview

Perm for all: `preview`. These drive the built-in browser tab (the same engine the agents' `open_preview` tools use). They reject with the tool's error text, e.g. `No preview tab is open. Call open_preview first.`

| Function | Params | Returns |
| --- | --- | --- |
| `open(options)` | `{ url? , file?, device?, reuse? }`: `url` or a workspace `file`; `device` e.g. `"iPhone 14"`; `reuse` (default true) navigates the current preview tab | `{ id, url, title }` - `url`/`title` can still be empty when the page is slow to load |
| `screenshot(options?)` | `{ id?, width?, height? }` | `{ data (base64 PNG), mimeType }` or `null` |
| `console(options?)` | `{ id?, level?: 'error' \| 'warn' \| 'all', clear?, limit? }` | text, one message per line |

```js
exports.activate = (reva) => {
  reva.commands.register('preview', async () => {
    const tab = await reva.preview.open({ url: 'http://localhost:3000' });
    reva.log.info('opened', tab.id);
    try {   // rejects with 'Page not ready' when the page failed to load (nothing listening on the port)
      const shot = await reva.preview.screenshot({ id: tab.id });
      reva.log.info('png bytes (base64):', shot ? shot.data.length : 0, await reva.preview.console({ level: 'warn' }));
    } catch (e) { reva.log.warn('no screenshot:', e.message); }
  });
};
```

## reva.settings

Your plugin's settings (declare them in [`contributes.settings`](manifest.md#settings) to get a form in the manager). Stored in Reva's settings under `plugins.<id>`.

| Function | Perm | Returns |
| --- | --- | --- |
| `get(key, fallback?)` | - | the stored value, else the manifest `default`, else `fallback` |
| `set(key, value)` | - | persists; fires `onDidChange` (no type validation) |
| `all()` | - | object with every declared key (defaults) overlaid with stored values |
| `onDidChange(cb)` | - | `cb(key, value)` after `set` or the manager form changes a value; Disposable |
| `app.get(key)` | `settings` | value of one of **Reva's own** settings (e.g. `theme`, `accent`, `editorFont`, `tabSize`); objects are copied |
| `app.set(key, value)` | `settings` | changes a Reva setting (`plugins` is refused: `Use reva.settings.set for plugin settings`) |

```js
exports.activate = (reva) => {
  reva.settings.onDidChange((key, value) => reva.log.info('changed', key, '->', value));
  reva.commands.register('toggle', () => reva.settings.set('enabled', !reva.settings.get('enabled', true)));
  reva.commands.register('wrap', () => reva.settings.app.set('wordWrap', 'on'));   // needs "settings"
};
```

## reva.storage

Persistent JSON key/value per plugin, in `<userData>\plugin-data\<id>\storage.json`. **1 MB total** (`Plugin storage is limited to 1024 KB`). Survives updates, disabling and Reva restarts; deleted when the plugin is uninstalled. Values must be JSON-serialisable. Perm: -.

| Function | Returns |
| --- | --- |
| `get(key, fallback?)` | Promise of the value, or `fallback` when the key does not exist |
| `set(key, value)` | Promise&lt;void&gt; |
| `delete(key)` | Promise&lt;void&gt; |
| `keys()` | Promise&lt;string[]&gt; |

```js
exports.activate = async (reva) => {
  const runs = (await reva.storage.get('runs', 0)) + 1;
  await reva.storage.set('runs', runs);
  await reva.storage.set('last', { at: Date.now(), by: reva.id });
  reva.log.info('run #' + runs, await reva.storage.keys());
};
```

## reva.theme

| Function | Perm | Notes |
| --- | --- | --- |
| `register(theme, id?)` | - | registers `{ name, dark, v, t }` (see [themes](manifest.md#themes)) and returns the full theme id `p-<pluginId>-<id>`. Colours in `v` must be `#rrggbb`. Error: `theme must look like {name, dark, v:{...}, t:{...}}` |
| `apply(id)` | `settings` | switches Reva to a theme: the full id, or a local id of yours. Error: `Unknown theme <id>` |
| `list()` | - | full ids of the themes of this plugin |

```js
exports.activate = (reva) => {
  const id = reva.theme.register({ name: 'Mono', dark: true, v: { bg: '#101010', bg1: '#161616', bg2: '#1e1e1e', bg3: '#282828', border: '#303030', fg: '#eeeeee', fg2: '#aaaaaa', fg3: '#707070', accent: '#ffffff', accent2: '#cccccc' }, t: { keyword: 'ffffff', string: 'bbbbbb' } }, 'mono');
  reva.commands.register('use-mono', () => reva.theme.apply(id));   // needs "settings"
};
```

## reva.events

An in-process bus shared by all plugins. Perm: -.

| Function | Notes |
| --- | --- |
| `on(name, cb)` | `cb(data, fromPluginId)`; Disposable |
| `once(name, cb)` | same, auto-removes after the first event |
| `emit(name, data?)` | calls every listener synchronously; a listener's exception is isolated per listener |

```js
exports.activate = (reva) => {
  reva.events.on('demo:ping', (data, from) => reva.log.info('ping', data, 'from', from));
  reva.commands.register('ping', () => reva.events.emit('demo:ping', { at: Date.now() }));
};
```

Namespace your event names (`my-plugin:thing`).

## reva.log

`debug`, `info`, `warn`, `error` take any arguments; strings are joined with spaces, `Error` objects print their stack, other values `JSON.stringify`. The last 500 lines per plugin are kept and shown in the manager; `error` lines (and everything in Developer mode) also go to DevTools. Perm: -.

```js
exports.activate = (reva) => {
  reva.log.debug('only visible in the log');
  reva.log.info('count', 3, { a: 1 });
  reva.log.warn('careful');
  reva.log.error(new Error('printed with a stack'));
};
```

## reva.fetch

### `fetch(url, options?)` -> Promise&lt;Response-like&gt;

Perm: `network` (add `network.local` to reach `localhost`, `127.x`, `10.x`, `172.16-31.x`, `192.168.x`, link-local, IPv6 loopback/ULA). The request is made by Reva's main process, so there is **no CORS**. Only `http:` and `https:`; at most 5 redirects (each hop is checked again); the body is limited to 5 MB.

| Option | Type | Notes |
| --- | --- | --- |
| `method` | string | default `GET` |
| `headers` | object | |
| `body` | string or object | an object is sent as JSON and `content-type: application/json` is added if you did not set one |
| `timeout` | number (ms) | default 20000, max 60000 |

Returns `{ ok, status, statusText, url, headers: { get(name), all }, text(), json(), base64() }`. It resolves for HTTP error statuses (`ok` is false); it **rejects** for network problems and policy errors: `Blocked: <host> is on a private/local network (needs the "network.local" permission)`, `Only http(s) URLs can be fetched`, `Too many redirects`, `Response is larger than 5 MB`, or the network error text.

```js
exports.activate = (reva) => {
  reva.commands.register('zen', async () => {
    const res = await reva.fetch('https://api.github.com/zen', { headers: { 'user-agent': 'reva-plugin' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    reva.ui.toast((await res.text()).trim());
  });
  reva.commands.register('post', async () => {
    const res = await reva.fetch('https://httpbin.org/post', { method: 'POST', body: { hello: 'world' } });
    reva.log.info(res.status, (await res.json()).json);
  });
};
```
