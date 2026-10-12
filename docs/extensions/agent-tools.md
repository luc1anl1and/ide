# Agent tools

A plugin can give **Claude Code, Codex and OpenCode** (and custom agents) new tools. Reva already runs a small MCP server for its agents (`reva-ide`: preview, screenshots, terminal, editor tools). Plugin tools are merged into that server, so every agent started from Reva sees them next to the built-in ones.

```
agent  --tools/call-->  ide-mcp.js (127.0.0.1, Bearer token)  --ide:call-->  renderer IDE.exec  -->  your handler(args)
agent  <--- result ----                                       <------------------------------------  string / {text} / {image} / ...
```

Needs the `agents` permission.

## Declare and register

Do both. The manifest entry makes the tool visible to agents **before** your script has started (Reva starts the plugin on the first call); the registration provides the code.

`plugin.json`:

```json
{
  "id": "npm-scripts", "name": "npm Scripts", "version": "1.0.0", "main": "index.js", "reva": ">=0.3.0",
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

`index.js`:

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

If a tool is declared but never registered, the call returns `Unknown plugin tool: <pluginId>__<name>`. If it is registered but not declared, agents only see it once the plugin has started. The code definition (description, schema, `readOnly`) overrides the declared one when both exist.

## Naming

| Piece | Rule |
| --- | --- |
| `name` in your plugin | `^[a-zA-Z][a-zA-Z0-9_]{0,40}$` (letters, digits, underscore) |
| name the agent sees | `<pluginId>__<name>` - two underscores, e.g. `npm-scripts__list_scripts` |
| Claude Code calls it | `mcp__reva-ide__npm-scripts__list_scripts` |
| Codex calls it | server `reva-ide`, tool `npm-scripts__list_scripts` |

**Keep `<pluginId>__<name>` at 49 characters or fewer.** The Reva server accepts up to 64 and **silently drops** longer names (a 71-character name never shows up in `tools/list`), and Claude's API caps the full `mcp__reva-ide__...` name at 64. Names that equal a built-in tool (`ide_context`, `open_file`, `open_preview`, `preview_*`, `terminal_*`) are dropped too.

Write the `description` for the model: what the tool does, what it returns, **when to call it**. It is the only documentation the agent gets (cut off at 2000 characters).

## inputSchema rules

`inputSchema` is a JSON Schema describing the arguments. Reva forces `type: "object"` and a `properties` object; the rest is passed to the agent unchanged.

```js
inputSchema: {
  type: 'object',
  properties: {
    path:  { type: 'string',  description: 'File to inspect, relative to the workspace' },
    depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Default 2' },
    mode:  { type: 'string',  enum: ['short', 'long'] },
    tags:  { type: 'array',   items: { type: 'string' } },
  },
  required: ['path'],
}
```

What Reva itself enforces before your handler runs (everything else is advisory for the model, so **validate in the handler**):

| Check | Result |
| --- | --- |
| `required` property missing, `null` or `""` | `Invalid arguments for <tool>: Missing required argument "<k>"` (error result, handler not called) |
| declared `type` is `string`, `boolean`, `integer`, `number`, `array` or `object` and the value differs | `Invalid arguments for <tool>: Argument "<k>" must be integer` |
| value not in `enum` | `Invalid arguments for <tool>: Argument "<k>" must be one of short, long` |
| unknown argument | passed through to the handler (no error) |
| `null`/`undefined` values | dropped before the handler is called, so destructuring defaults work |
| `minimum`, `maximum`, `pattern`, `minLength`, `items`, ... | **not** checked |

Prefer few, flat, well-described parameters. Use `enum` for choices. Make everything optional that can have a default.

## Return formats

`handler(args)` may return (sync or async):

| Return | What the agent receives |
| --- | --- |
| a string | text |
| `null` / `undefined` | text `OK` |
| `{ text: '...', isError?: true }` | text (an error result when `isError`) |
| `{ image: '<base64 png>', mimeType?: 'image/png' }` | an image |
| `{ content: [{ type: 'text', text }, { type: 'image', data, mimeType }], isError? }` | exactly these blocks (the MCP shape; a `data:` URL prefix on images is stripped) |
| any other object/array/number/boolean | pretty-printed JSON text |

**Throw** to report a failure: the agent gets `Error: <message>` with `isError: true` (and the plugin's error counter goes up; 5 consecutive failures disable the plugin). Return `{ text, isError: true }` for an expected "no" that should not count as a plugin bug.

```js
handler: async ({ q }) => {
  const hits = await reva.workspace.search(q, { max: 20 });
  if (!hits.length) return { text: 'No matches for ' + q, isError: false };
  return { total: hits.length, hits: hits.map((h) => `${h.file}:${h.line}  ${h.text.trim()}`) };   // -> JSON text
}
```

Keep results short (a few KB): agents pay for every character. A tool call must finish well inside **25 s** (the MCP server gives up after 25 s with `The IDE did not answer <tool> within 25 s`; Codex's own tool timeout is 60 s, OpenCode's 30 s). For long jobs return quickly with a job id and offer a second tool to poll.

## readOnly and approvals

`readOnly: true` marks a tool as free of side effects: it is advertised with MCP annotation `readOnlyHint: true`, and Reva pre-approves it for **Claude and Codex**. Without it the tool is advertised as a normal (non-read-only) action. Only set it when it is true: it removes the user's confirmation.

How each agent treats plugin tools:

| Agent | Tool is `readOnly` | Tool is not `readOnly` |
| --- | --- | --- |
| **Claude Code** | Reva starts Claude with `--allowedTools mcp__reva-ide__<tool>`: runs without asking. | Goes through Reva's permission prompt (`--permission-prompt-tool stdio`), so Reva's approval card appears in *Ask first* mode (more permissive modes of the chat can skip it). |
| **Codex** | Reva sets `mcp_servers.reva-ide.tools.<tool>.approval_mode="approve"`: runs without asking. | Reva sets `default_tools_approval_mode="prompt"`, so Codex raises an MCP approval request (shown in the chat as `mcp__reva-ide__elicitation`) for every such call. |
| **OpenCode** and custom agents (run through OpenCode) | no confirmation | **no confirmation**: Reva's OpenCode integration has no permission round trip, so every plugin tool call runs immediately. |

Consequences: design every tool as if it can be called without a human looking (especially for OpenCode). The read-only allow-list is computed **when a chat's agent starts**; so is the whole tool list:

> **Agents only pick up new or changed tools in a NEW chat.** After enabling a plugin, adding a tool or changing `readOnly`, open a new chat (*Ctrl+Shift+N*). A running Claude/Codex session keeps the tool list it started with. (OpenCode starts a fresh process for each message, so it may notice sooner; do not rely on it.)

Handy check from the renderer console: `RevaPlugins.toolList()` is what Reva currently offers; ask the agent *"list your tools whose name contains __"* in the new chat.

## Rules for tools

- Tools run in the renderer through the plugin's `reva` object; they can do anything the plugin's permissions allow (read files, run `reva.terminal.run`, `reva.fetch`, ...).
- The workspace is whatever folder **Reva** has open (`reva.workspace.root`), not necessarily the chat's working directory. Return a clear error when it is `null`.
- Handlers can be called concurrently and at any time, including while the plugin's panels are closed. Don't depend on UI state. Don't open modal dialogs from a tool: the user may not be looking and the 25 s timeout will fire.
- Registration errors: `registerTool: "name" must be letters, digits and underscores (got "<x>")`, `registerTool needs a handler(args) function`, `registerTool needs a description (agents read it to decide when to call the tool)`. Declaration errors are in [manifest.md](manifest.md#agenttools).

## Security

Treat an agent as an untrusted caller, and everything it passes as untrusted input: a prompt-injected web page or file can make an agent call your tools with hostile arguments.

- **Least power.** Prefer read-only tools. Split "read" and "write" into separate tools, and mark only the first `readOnly`.
- **Confine paths.** If a tool takes a path, resolve it against the workspace and refuse `..`/absolute paths outside it:
  ```js
  const rel = String(args.path || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) throw new Error('path must be relative and inside the workspace');
  ```
- **Never pass tool arguments to a shell** (`reva.terminal.run`) without strict allow-listing; expose named operations (`run_tests`) instead of "run any command".
- **Bound everything.** Cap result sizes, result counts, file sizes, loop counts and time.
- **No secrets in results or descriptions.** Everything a tool returns goes to a third-party model provider.
- **Be honest with `readOnly`.** It disables the confirmation prompt for Claude and Codex.
- **Network tools** need `network`; keep an allow-list of hosts if the URL comes from the agent.
- Destructive tools should default to a dry run (`apply: false`) and describe the plan, so the model must call again with `apply: true` after the user has seen it.
- Remember that the permissions are not a sandbox ([trust model](README.md#trust-model-and-permissions)); users should only enable plugins they trust, and a plugin's tools are as trusted as its code.

## Worked example, tested end to end

The plugin above (`npm-scripts`) was checked three ways.

**1. Through the renderer, exactly as an agent call reaches your handler** (`IDE.exec` is what `ide:call` invokes). Run it with the [test harness](getting-started.md#test-a-plugin-without-clicking-for-developers-and-ai-agents) after opening a folder that has a `package.json`:

```js
(async () => {
  await App.setWorkspace('C:\\path\\to\\project');
  const r = await RevaPlugins.install('C:\\path\\to\\npm-scripts', { overwrite: true });
  await RevaPlugins.enable(r.id, { confirm: true, skipDialog: true });
  console.log(JSON.stringify(RevaPlugins.toolList().map((t) => t.name + (t.readOnly ? ' (read-only)' : ''))));
  const out = await IDE.exec('npm-scripts__list_scripts', {});          // same entry point as an agent call
  return JSON.stringify(out);
})()
```

Result: `["npm-scripts__list_scripts (read-only)"]` and `{"content":[{"type":"text","text":"demo-app\ndev: vite\nbuild: vite build\ntest: vitest run\nlint: eslint ."}]}`. With `{ package: 'nope' }` the result is `{ isError: true, content: [{ text: "Error: ENOENT: no such file or directory, stat '...\\nope\\package.json'" }] }`.

**2. Over HTTP through the real server code** (`src/ide-mcp.js`) with a mock renderer. [examples/mcp-roundtrip.js](examples/mcp-roundtrip.js) starts `start({ invoke, getExtraTools })` on a random port, then speaks MCP/JSON-RPC to it with a Bearer token:

```
node docs\extensions\examples\mcp-roundtrip.js C:\path\to\project
PASS: tools/list, tools/call, validation, image results, auth
```

It asserts: a wrong token gives `401`; `tools/list` contains the plugin tool (with `readOnlyHint: true`) and the built-in tools; `tools/call` returns the handler's text; a bad `enum` value, a missing `required` argument and a wrong type give `isError` results *without* calling the handler; an image result comes back as an `image` block (the `data:` prefix removed); an unknown tool is JSON-RPC error `-32602`. The shape of the raw messages:

```jsonc
// -> POST http://127.0.0.1:<port>/mcp   Authorization: Bearer <token>
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "npm-scripts__list_scripts", "arguments": { "package": "demo-app" } } }
// <-
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "start: node server.js" }] } }
```

**3. From a real agent.** Enable the plugin, open a **new chat**, and ask: *"What scripts does this project have? Use the npm-scripts tool."* The agent calls `npm-scripts__list_scripts`; the call appears as a tool card in the chat. (The server's address and token exist only inside the running Reva, so you cannot point an outside client at it.)

Built-in example with two tools: *Plugins > Built-in examples > Agent Tools Demo* (`random_uuid`, `workspace_stats`).
