// Round trip through Reva's real MCP server code (src/ide-mcp.js) with a mock "renderer".
//   node mcp-roundtrip.js <path-to-a-project-with-package.json> [<path-to-Reva>]
// Verifies: tools/list contains the plugin tool, tools/call works, argument validation, image results, auth.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const project = process.argv[2];
const reva = process.argv[3] || path.resolve(__dirname, '..', '..', '..');       // docs/extensions/examples -> repo root
const mcp = require(path.join(reva, 'src', 'ide-mcp.js'));

// 1) What the plugin runtime pushes to the main process (RevaPlugins.toolList()): one entry per tool.
const pluginTools = [{
  name: 'npm-scripts__list_scripts',
  description: "Lists the scripts in the open project's package.json (name and command).",
  inputSchema: { type: 'object', properties: { package: { type: 'string' }, mode: { type: 'string', enum: ['short', 'long'] } } },
  readOnly: true,
}, {
  name: 'demo__need', description: 'needs an argument', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
}, { name: 'demo__shot', description: 'returns an image', inputSchema: { type: 'object', properties: {} } }];

// 2) The mock invoke() plays the renderer: in Reva it is RevaPlugins.callTool(name, args) -> your handler.
const invoke = async (name, args) => {
  if (name === 'npm-scripts__list_scripts') {
    const pkg = JSON.parse(fs.readFileSync(path.join(project, args.package || '.', 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    return { content: [{ type: 'text', text: Object.entries(pkg.scripts || {}).map(([k, v]) => k + ': ' + v).join('\n') }] };
  }
  if (name === 'demo__need') return { content: [{ type: 'text', text: 'got ' + args.q }] };
  if (name === 'demo__shot') return { content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }, { type: 'text', text: 'caption' }] };
  throw new Error('unreachable');
};

(async () => {
  const srv = await mcp.start({ invoke, getExtraTools: () => pluginTools });   // main.js passes plugins.getExtraTools here
  const rpc = async (body, token = srv.token) => {
    const r = await fetch(srv.url, { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token } });
    const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null };
  };
  const call = async (name, args) => (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body;

  assert.strictEqual((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong-token')).status, 401);       // Bearer token required

  const tools = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools;
  const t = tools.find((x) => x.name === 'npm-scripts__list_scripts');
  assert(t, 'plugin tool is listed next to the built-in ones');
  assert.strictEqual(t.annotations.readOnlyHint, true);                                                          // readOnly -> annotation
  assert(tools.some((x) => x.name === 'open_preview'), 'built-in tools are still there');

  const ok = (await call('npm-scripts__list_scripts', {})).result;
  assert(!ok.isError && /: /.test(ok.content[0].text), ok.content[0].text);
  const bad = (await call('npm-scripts__list_scripts', { mode: 'huge' })).result;
  assert(bad.isError && /must be one of short, long/.test(bad.content[0].text));                                  // enum is enforced
  const missing = (await call('demo__need', {})).result;
  assert(missing.isError && /Missing required argument "q"/.test(missing.content[0].text));                       // required is enforced
  const img = (await call('demo__shot', {})).result;
  assert.strictEqual(img.content[0].type, 'image');
  assert.strictEqual((await call('nope__x', {})).error.code, -32602);                                             // unknown tool

  console.log('PASS: tools/list, tools/call, validation, image results, auth');
  console.log(ok.content[0].text);
  await srv.close();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });