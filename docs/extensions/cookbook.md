# Cookbook

Seventeen small plugins, each one complete (`plugin.json` + code, 40 lines or fewer) and **tested** by installing it into a throw-away Reva profile and asserting its effect (41 assertions, all passing on Reva 0.4.0; screenshots below).

**To try one:** create a folder named like the `id`, save the files in it, then *Plugins > Install from folder...* (or copy the folder into `%APPDATA%\Reva\plugins`) and enable it. Reva asks you to approve the permissions it lists.

1. [Status bar clock](#1-status-bar-clock)
2. [A command that inserts a timestamp](#2-a-command-that-inserts-a-timestamp)
3. [A sidebar panel with file statistics (no git)](#3-a-sidebar-panel-with-file-statistics-no-git)
4. [A TODO scanner](#4-a-todo-scanner)
5. [A custom theme (no code)](#5-a-custom-theme-no-code)
6. [Snippets](#6-snippets)
7. [A language with a tokenizer and hover](#7-a-language-with-a-tokenizer-and-hover)
8. [A formatter](#8-a-formatter)
9. [A slash command that rewrites prompts](#9-a-slash-command-that-rewrites-prompts)
10. [An agent tool that reads a project's package.json scripts](#10-an-agent-tool-that-reads-a-projects-packagejson-scripts)
11. [A save hook](#11-a-save-hook)
12. [A file action in the Explorer context menu](#12-a-file-action-in-the-explorer-context-menu)
13. [Using reva.fetch](#13-using-revafetch)
14. [A persistent storage counter](#14-a-persistent-storage-counter)
15. [A settings form](#15-a-settings-form)
16. [A preview helper that opens localhost](#16-a-preview-helper-that-opens-localhost)
17. [Editor decorations](#17-editor-decorations)

## 1. Status bar clock

A live clock at the right end of the status bar. Shows a timer that must be cleaned up in `deactivate` (timers are not disposed for you).

`status-clock/plugin.json`

```json
{
  "id": "status-clock",
  "name": "Status Clock",
  "version": "1.0.0",
  "description": "A clock in the status bar.",
  "main": "index.js",
  "reva": ">=0.3.0"
}
```

`status-clock/index.js`

```js
let timer;   // module scope: timers are NOT cleaned up automatically

exports.activate = (reva) => {
  const item = reva.ui.addStatusItem({ id: 'clock', align: 'right', icon: 'history', tooltip: 'Local time' });
  const tick = () => item.update({ text: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
  tick();
  timer = setInterval(tick, 15000);
};

exports.deactivate = () => clearInterval(timer);
```

**Verified:** The item shows `HH:MM` after activation.

## 2. A command that inserts a timestamp

Palette command + keyboard shortcut (`Ctrl+Alt+T`) that types the current local date and time at the cursor, as one undo step. Needs `workspace.write`.

`insert-timestamp/plugin.json`

```json
{
  "id": "insert-timestamp",
  "name": "Insert Timestamp",
  "version": "1.0.0",
  "description": "Inserts the current date and time at the cursor (Ctrl+Alt+T).",
  "main": "index.js",
  "reva": ">=0.3.0",
  "permissions": ["workspace.write"],
  "contributes": {
    "commands": [{ "id": "insert", "title": "Insert Timestamp", "keybinding": "Ctrl+Alt+T" }]
  }
}
```

`insert-timestamp/index.js`

```js
exports.activate = (reva) => {
  reva.commands.register('insert', () => {
    const stamp = new Date().toLocaleString('sv-SE');
    reva.editor.insertText(stamp);   // throws "No editor is open" when there is no editor; Reva shows it as a toast
  });
};
```

**Verified:** Running the command, and pressing the shortcut, inserted `2026-10-12 21:31:19` at the cursor.

## 3. A sidebar panel with file statistics (no git)

A panel next to *Files* that counts files and lines per extension using `findFiles` + `readFile`. `render` runs every time the panel is shown; the refresh button in the panel header re-runs it. Needs `workspace.read`.

`file-stats/plugin.json`

```json
{
  "id": "file-stats",
  "name": "File Stats",
  "version": "1.0.0",
  "description": "Sidebar panel: files and lines per extension (no git needed).",
  "main": "index.js",
  "reva": ">=0.3.0",
  "permissions": ["workspace.read"],
  "contributes": {
    "sidebarPanels": [{ "id": "stats", "title": "File Stats", "icon": "gauge" }]
  }
}
```

`file-stats/index.js`

```js
exports.activate = (reva) => {
  const { h } = reva.ui;
  reva.ui.addSidebarPanel({
    id: 'stats', title: 'File Stats', icon: 'gauge',
    async render(box) {
      if (!reva.workspace.root) { box.replaceChildren(h('div', { class: 'empty' }, 'Open a folder first')); return; }
      box.replaceChildren(h('div', { class: 'empty' }, 'Counting...'));
      const files = await reva.workspace.findFiles('**/*.{js,ts,py,md,json,html,css}', { max: 300 });
      const by = {};
      for (const f of files) {
        const ext = f.split('.').pop().toLowerCase();
        const lines = (await reva.workspace.readFile(f)).split('\n').length;
        const row = (by[ext] = by[ext] || { files: 0, lines: 0 });
        row.files++; row.lines += lines;
      }
      const rows = Object.entries(by).sort((a, b) => b[1].lines - a[1].lines);
      box.replaceChildren(h('div', { style: { padding: '12px 14px' } },
        h('div', { class: 'u-note' }, files.length + ' files'),
        ...rows.map(([ext, r]) => h('div', { class: 'row' }, h('b', null, '.' + ext), h('span', { style: { marginLeft: 'auto' } }, r.files + ' files, ' + r.lines + ' lines')))));
    },
  });
};
```

**Verified:** Opening the panel listed `.js`, `.md`, `.html`, `.json`, `.py` rows. Screenshot below.

![A sidebar panel with file statistics (no git)](img/recipes-file-stats-fixme.png)

## 4. A TODO scanner

A command that searches the workspace for `TODO`/`FIXME` comments, lets you pick one in a searchable list, and opens the file at that line. Needs `workspace.read`. (For a full sidebar version see the built-in *TODO Sidebar* example.)

`todo-picker/plugin.json`

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

`todo-picker/index.js`

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

**Verified:** The picker listed 3 comments; choosing one opened the file at the right line.

## 5. A custom theme (no code)

A theme is a JSON file referenced from the manifest, no `main` needed. UI colours in `v` are `#rrggbb`, editor token colours in `t` are `rrggbb`. The theme id is `p-ocean-theme-deep`; it appears in *Settings > Appearance*, the status bar theme picker and the palette.

`ocean-theme/plugin.json`

```json
{
  "id": "ocean-theme",
  "name": "Ocean Theme",
  "version": "1.0.0",
  "description": "A deep blue dark theme. No code.",
  "reva": ">=0.3.0",
  "contributes": { "themes": [{ "id": "deep", "name": "Ocean Deep", "file": "themes/deep.json" }] }
}
```

`ocean-theme/themes/deep.json`

```json
{
  "name": "Ocean Deep",
  "dark": true,
  "v": { "bg": "#08141f", "bg1": "#0c1c2a", "bg2": "#112638", "bg3": "#183249", "border": "#1c3a54",
         "fg": "#e3f1fb", "fg2": "#9bb9cf", "fg3": "#5f8099", "accent": "#2fb4ff", "accent2": "#7fd4ff" },
  "t": { "keyword": "3fb7ff", "string": "9be28a", "number": "ffb86b", "comment": "4d7089",
         "type": "5eead4", "func": "ffd479", "variable": "e3f1fb", "operator": "ff8ad8" }
}
```

**Verified:** The theme registered as `p-ocean-theme-deep` and applying it recoloured the UI and editor. Screenshot below.

![A custom theme (no code)](img/recipes-theme-language-clock.png)

## 6. Snippets

Declarative snippets in VS Code format: type `tbl`, `todo`, `task` or `link` in a Markdown file and accept the completion.

`markdown-snippets/plugin.json`

```json
{
  "id": "markdown-snippets",
  "name": "Markdown Snippets",
  "version": "1.0.0",
  "description": "Type 'tbl', 'todo' or 'link' in a Markdown file and accept the completion.",
  "reva": ">=0.3.0",
  "contributes": { "snippets": [{ "language": "markdown", "file": "snippets.json" }] }
}
```

`markdown-snippets/snippets.json`

```json
{
  "Table 2x2": { "prefix": "tbl", "body": ["| ${1:A} | ${2:B} |", "| --- | --- |", "| ${3} | ${4} |"], "description": "2x2 table" },
  "Task": { "prefix": ["todo", "task"], "body": "- [ ] ${1:thing to do}", "description": "Checklist item" },
  "Link": { "prefix": "link", "body": "[${1:text}](${2:https://})", "description": "Link" }
}
```

**Verified:** In a `.md` file typing `tbl` offered the "Table 2x2" snippet.

## 7. A language with a tokenizer and hover

The manifest declares the language (id, extension, bracket/comment configuration); `index.js` adds syntax highlighting with a Monarch tokenizer and a hover. Open a `.rvl` file to try it.

`rvl-language/plugin.json`

```json
{
  "id": "rvl-language",
  "name": "RVL Language",
  "version": "1.0.0",
  "description": "Adds a tiny .rvl language with syntax highlighting and a hover.",
  "main": "index.js",
  "reva": ">=0.3.0",
  "contributes": {
    "languages": [{ "id": "rvl", "extensions": [".rvl"], "aliases": ["RVL"], "configuration": "language.json" }]
  }
}
```

`rvl-language/language.json`

```json
{
  "comments": { "lineComment": "//" },
  "brackets": [["{", "}"], ["(", ")"]],
  "autoClosingPairs": [{ "open": "{", "close": "}" }, { "open": "\"", "close": "\"" }]
}
```

`rvl-language/index.js`

```js
exports.activate = (reva) => {
  reva.editor.registerTokenizer('rvl', {
    keywords: ['let', 'fn', 'if', 'else', 'return', 'print'],
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/"[^"]*"/, 'string'],
        [/\b\d+(\.\d+)?\b/, 'number'],
        [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/[{}()=+\-*\/<>]/, 'operator'],
      ],
    },
  });
  reva.editor.registerHoverProvider('rvl', { provideHover: ({ word }) => (word === 'fn' ? '**fn** declares a function' : null) });
};
```

**Verified:** A `.rvl` file opened as language `rvl`, keywords/strings/numbers were tokenised, and the hover on `fn` showed the text. (Screenshot above, on the code editor.)

![A language with a tokenizer and hover](img/recipes-theme-language-clock.png)

## 8. A formatter

Registers a *Format Document* provider for plain-text files that trims trailing whitespace and ends the file with a single newline (right-click in the editor > Format Document). Needs `workspace.write`. Registering for a language that already has a formatter (JS, JSON, ...) makes the editor ask which to use.

`trim-formatter/plugin.json`

```json
{
  "id": "trim-formatter",
  "name": "Trim Formatter",
  "version": "1.0.0",
  "description": "Format Document on plain text: trims trailing spaces and ends the file with one newline.",
  "main": "index.js",
  "reva": ">=0.3.0",
  "permissions": ["workspace.write"]
}
```

`trim-formatter/index.js`

```js
exports.activate = (reva) => {
  reva.editor.registerFormatter('plaintext', (text, { path }) => {
    reva.log.info('formatting', path);
    return text.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n*$/, '\n');
  });
};
```

**Verified:** `"a  \nb\t\n\n\n"` became `"a\nb\n"` via the Format Document action.

## 9. A slash command that rewrites prompts

Typing `/review security` in the chat sends a full code-review prompt that names the open file. A command that returns a string rewrites the message; returning nothing sends nothing. Needs `chat` and `workspace.read`.

`prompt-rewriter/plugin.json`

```json
{
  "id": "prompt-rewriter",
  "name": "Prompt Rewriter",
  "version": "1.0.0",
  "description": "/review [focus] expands into a detailed code-review prompt that includes the open file.",
  "main": "index.js",
  "reva": ">=0.3.0",
  "permissions": ["chat", "workspace.read"],
  "contributes": { "slashCommands": [{ "name": "review", "description": "Review the open file" }] }
}
```

`prompt-rewriter/index.js`

```js
exports.activate = (reva) => {
  reva.chat.registerSlashCommand({
    name: 'review',
    description: 'Review the open file',
    run(args) {
      const f = reva.editor.activeFile();
      if (!f) { reva.ui.toast('Open a file first', 'error'); return; }   // returning nothing = send nothing
      return `Review ${f.path} for bugs, unclear names and missing error handling.` +
        (args ? ` Focus on: ${args}.` : '') + ' List findings by severity, then propose minimal fixes.';
    },
  });
};
```

**Verified:** `/review security` expanded to the full prompt; other messages passed through unchanged.

## 10. An agent tool that reads a project's package.json scripts

A read-only tool agents can call as `npm-scripts__list_scripts`. Declared in the manifest (visible to agents immediately) and registered in code. Strips a UTF-8 BOM before `JSON.parse`. More in [agent-tools.md](agent-tools.md). Remember: agents see new tools in a **new chat**.

`npm-scripts/plugin.json`

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

`npm-scripts/index.js`

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

**Verified:** Called through `IDE.exec` (what an agent call becomes) and over HTTP through `ide-mcp.js`; the root and a sub-package (`demo-app`) returned their scripts.

## 11. A save hook

`onWillSave` runs before the file is written (the text you set is what lands on disk); `onDidSave` runs after. Strips trailing whitespace on every save. `activeFile` needs `workspace.read`, `setText` needs `workspace.write`.

`save-hook/plugin.json`

```json
{
  "id": "save-hook",
  "name": "Save Hook",
  "version": "1.0.0",
  "description": "Strips trailing spaces before every save and logs after it.",
  "main": "index.js",
  "reva": ">=0.3.0",
  "permissions": ["workspace.read", "workspace.write"]
}
```

`save-hook/index.js`

```js
exports.activate = (reva) => {
  reva.editor.onWillSave(({ path, isActive }) => {
    if (!isActive) return;                       // setText only works on the visible editor
    const f = reva.editor.activeFile();
    const clean = f.text.replace(/[ \t]+$/gm, '');
    if (clean !== f.text) reva.editor.setText(clean);   // runs BEFORE the file is written
  });
  reva.editor.onDidSave((path) => reva.log.info('saved', path));   // runs AFTER
};
```

**Verified:** With `"keep   \nme  "` in the editor, Ctrl+S wrote `"keep\nme"` to disk and logged `saved <path>`.

## 12. A file action in the Explorer context menu

Right-click a `.js`, `.ts` or `.py` file > **Count Lines**. A `fileActions` entry runs the command with the same id and passes it the absolute path. It is hidden for other file types. Needs `workspace.read`.

`line-counter/plugin.json`

```json
{
  "id": "line-counter",
  "name": "Line Counter",
  "version": "1.0.0",
  "description": "Right-click a .js/.ts/.py file in the Explorer: Count Lines.",
  "main": "index.js",
  "reva": ">=0.3.0",
  "permissions": ["workspace.read"],
  "contributes": {
    "commands": [{ "id": "countLines", "title": "Count Lines in File" }],
    "fileActions": [{ "id": "countLines", "title": "Count Lines", "when": { "extensions": ["js", "ts", "py"] } }]
  }
}
```

`line-counter/index.js`

```js
exports.activate = (reva) => {
  // file actions call the command with the absolute path of the clicked item
  reva.commands.register('countLines', async (fullPath) => {
    const text = await reva.workspace.readFile(fullPath);
    reva.ui.toast(fullPath.split('\\').pop() + ': ' + text.split('\n').length + ' lines');
  });
};
```

**Verified:** The item appeared for `app.js` and not for `plain.txt`; running it toasted `app.js: N lines`.

## 13. Using reva.fetch

Fetches a line of text with `reva.fetch` (runs in the main process: no CORS) and puts it in the status bar. The URL is a setting (*Plugins > Zen Fetch > Settings*). Needs `network`; pointing the URL at `http://127.0.0.1:...` fails with `Blocked: ...` unless you also add `network.local`.

`zen-fetch/plugin.json`

```json
{
  "id": "zen-fetch",
  "name": "Zen Fetch",
  "version": "1.0.0",
  "description": "Fetches a line of text from a URL (setting) and shows it in the status bar.",
  "main": "index.js",
  "reva": ">=0.3.0",
  "permissions": ["network"],
  "contributes": {
    "commands": [{ "id": "fetch", "title": "Zen Fetch: Get Quote" }],
    "settings": [{ "key": "url", "title": "URL", "type": "string", "default": "https://api.github.com/zen" }]
  }
}
```

`zen-fetch/index.js`

```js
exports.activate = (reva) => {
  const item = reva.ui.addStatusItem({ id: 'zen', align: 'left', text: '' });
  reva.commands.register('fetch', async () => {
    const res = await reva.fetch(reva.settings.get('url'), { headers: { 'user-agent': 'reva-plugin' }, timeout: 8000 });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);   // shown as a toast + logged
    const text = (await res.text()).trim();
    item.update({ text: text.slice(0, 60), tooltip: text });
    reva.log.info('fetched', res.status, res.headers.get('content-type'));
  });
};
```

**Verified:** Fetched a real line from `api.github.com/zen` into the status bar; a localhost URL produced the `Blocked: 127.0.0.1 is on a private/local network` error.

## 14. A persistent storage counter

`reva.storage` is a per-plugin JSON store on disk. This counts activations across restarts and reloads and shows them in the status bar.

`launch-counter/plugin.json`

```json
{
  "id": "launch-counter",
  "name": "Launch Counter",
  "version": "1.0.0",
  "description": "Counts how many times Reva started with this plugin on (persistent storage).",
  "main": "index.js",
  "reva": ">=0.3.0"
}
```

`launch-counter/index.js`

```js
exports.activate = async (reva) => {
  const n = (await reva.storage.get('launches', 0)) + 1;   // second argument = default
  await reva.storage.set('launches', n);                    // stored in <userData>\plugin-data\launch-counter\storage.json
  reva.ui.addStatusItem({ id: 'n', align: 'right', text: 'launch #' + n, tooltip: 'Stored with reva.storage' });
  reva.log.info('keys', await reva.storage.keys());
};
```

**Verified:** The counter went 1, 2, 3, ... across plugin reloads.

## 15. A settings form

Every setting type declared in `contributes.settings` gets a form in *Plugins > Installed > Details*. The command reads them with `reva.settings.all()`, and `onDidChange` reacts to edits.

`greeter/plugin.json`

```json
{
  "id": "greeter",
  "name": "Greeter",
  "version": "1.0.0",
  "description": "Shows every setting type; the command greets using the values.",
  "main": "index.js",
  "reva": ">=0.3.0",
  "contributes": {
    "commands": [{ "id": "greet", "title": "Greeter: Greet" }],
    "settings": [
      { "key": "name", "title": "Name", "type": "string", "default": "world" },
      { "key": "loud", "title": "Shout", "type": "boolean", "default": false, "description": "UPPERCASE the greeting" },
      { "key": "times", "title": "Repeat", "type": "number", "default": 1, "min": 1, "max": 5 },
      { "key": "style", "title": "Style", "type": "select", "options": ["plain", "fancy"], "default": "plain" },
      { "key": "note", "title": "Note", "type": "text", "default": "" },
      { "key": "tint", "title": "Tint", "type": "color", "default": "#a78bfa" }
    ]
  }
}
```

`greeter/index.js`

```js
exports.activate = (reva) => {
  const greet = () => {
    const s = reva.settings.all();
    let msg = (s.style === 'fancy' ? '~ Hello, ' : 'Hello, ') + s.name + '!';
    msg = (s.loud ? msg.toUpperCase() : msg).repeat(s.times);
    reva.ui.toast(msg);
  };
  reva.commands.register('greet', greet);
  reva.settings.onDidChange((key, value) => reva.log.info('setting changed', key, value));
};
```

**Verified:** Changing `name`, `loud`, `times` programmatically logged each change and the command toasted `HELLO, REVA!HELLO, REVA!`. The form is in the first screenshot of [README.md](README.md).

## 16. A preview helper that opens localhost

Asks for a port and opens `http://localhost:<port>` in Reva's built-in browser preview. The command also accepts the port as an argument (`reva.commands.execute("open-localhost.open", 3000)`). Needs `preview`. Note that `open` can return before the page has finished loading (`url`/`title` may be empty).

`open-localhost/plugin.json`

```json
{
  "id": "open-localhost",
  "name": "Open Localhost",
  "version": "1.0.0",
  "description": "Asks for a port and opens http://localhost:<port> in the built-in preview.",
  "main": "index.js",
  "reva": ">=0.3.0",
  "permissions": ["preview"],
  "contributes": { "commands": [{ "id": "open", "title": "Open Localhost in Preview" }] }
}
```

`open-localhost/index.js`

```js
exports.activate = (reva) => {
  reva.commands.register('open', async (port) => {
    port = port || await reva.ui.prompt('Port to preview', { value: '3000' });   // prompt() resolves to undefined/'' when cancelled
    if (!port) return;
    const tab = await reva.preview.open({ url: 'http://localhost:' + port });     // -> { id, url, title }
    reva.log.info('opened', tab);
    return tab;
  });
};
```

**Verified:** With a local server on port 3987 the preview tab opened and rendered the page. Screenshot below (the red toast comes from the Zen Fetch recipe's localhost block).

![A preview helper that opens localhost](img/recipes-preview-localhost.png)

## 17. Editor decorations

Highlights every line containing `FIXME` in the active editor with a red background and a hover message, and repaints when you switch files or type. Needs `workspace.read`.

`fixme-highlight/plugin.json`

```json
{
  "id": "fixme-highlight",
  "name": "FIXME Highlight",
  "version": "1.0.0",
  "description": "Highlights lines containing FIXME in the active editor.",
  "main": "index.js",
  "reva": ">=0.3.0",
  "permissions": ["workspace.read"]
}
```

`fixme-highlight/index.js`

```js
exports.activate = (reva) => {
  const deco = reva.editor.decorate([]);
  const paint = () => {
    const f = reva.editor.activeFile();
    const items = [];
    (f ? f.text.split('\n') : []).forEach((l, i) => {
      if (/FIXME/.test(l)) items.push({ line: i + 1, background: 'rgba(255,80,80,0.18)', message: 'FIXME' });
    });
    deco.set(items);
  };
  reva.editor.onDidChangeActive(paint);
  reva.editor.onDidChangeText(paint);
  paint();
};
```

**Verified:** Line 4 of `app.js` (`// FIXME handle errors`) got the decoration. Screenshot below.

![Editor decorations](img/recipes-file-stats-fixme.png)

