// Agent Tools Demo - tools that every agent in Reva can call.
//
// reva.agents.registerTool() publishes a tool on Reva's built-in MCP server ("reva-ide"). The agent sees it as
// "<plugin id>__<tool name>", e.g. agent-tools-demo__random_uuid. The handler runs here in the renderer, so it can
// use the whole `reva` API. A handler may return a string, {text}, {content:[...]} or any JSON value; throwing
// reports an error to the agent. Tools are declared in plugin.json too, so agents can see them before this
// script has even started (Reva activates the plugin on the first call).
//
// Note: an agent session reads the tool list when it starts, so open a NEW chat after enabling the plugin.

exports.activate = (reva) => {
  reva.agents.registerTool({
    name: 'random_uuid',
    description: 'Generates one or more random UUIDs (v4). Use when you need fresh unique identifiers.',
    inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 50, description: 'How many UUIDs (default 1)' } } },
    readOnly: true,
    handler: async ({ count = 1 }) => {
      const n = Math.max(1, Math.min(50, Math.floor(count)));
      return Array.from({ length: n }, () => crypto.randomUUID()).join('\n');
    },
  });

  reva.agents.registerTool({
    name: 'workspace_stats',
    description: "Counts the files in the user's open workspace by extension. Fast overview of what kind of project this is.",
    inputSchema: { type: 'object', properties: { top: { type: 'integer', minimum: 1, maximum: 30, description: 'How many extensions to list (default 10)' } } },
    readOnly: true,
    handler: async ({ top = 10 }) => {
      if (!reva.workspace.root) throw new Error('No workspace folder is open in Reva');
      const files = await reva.workspace.findFiles('**/*', { max: 20000 });   // skips node_modules, .git, dist, ...
      const byExt = {};
      for (const f of files) { const m = /\.([^.\\/]+)$/.exec(f); const e = m ? m[1].toLowerCase() : '(none)'; byExt[e] = (byExt[e] || 0) + 1; }
      const rows = Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, top);
      return { workspace: reva.workspace.root, files: files.length, topExtensions: Object.fromEntries(rows) };
    },
  });

  reva.log.info('agent tools registered');
};
