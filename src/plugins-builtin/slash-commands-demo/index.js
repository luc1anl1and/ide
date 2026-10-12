// Slash Commands Demo - chat commands that run inside Reva before anything is sent to the agent.
//
// run(args, ctx) decides what happens with the message:
//   - return a string      -> that text is sent to the agent INSTEAD of what the user typed (a "rewrite")
//   - return nothing/false -> the command was handled locally; nothing is sent
// Commands also appear in the "/" autocomplete of the chat box.

exports.activate = (reva) => {
  // /standup [focus]  ->  rewrites into a detailed prompt
  reva.chat.registerSlashCommand({
    name: 'standup',
    description: 'Draft a standup update from recent git activity',
    run: (args) => [
      'Write my daily standup update.',
      'Look at `git log --since="yesterday" --oneline` (and `git status`) in this repository.',
      args ? 'Focus on: ' + args + '.' : '',
      'Format: **Yesterday** / **Today** / **Blockers**, 3 bullets at most each, plain language, no commit hashes.',
    ].filter(Boolean).join('\n'),
  });

  // /clear-todos  ->  works locally on the open file, sends nothing to the agent
  reva.chat.registerSlashCommand({
    name: 'clear-todos',
    description: 'Remove full-line TODO comments from the open file',
    run: async () => {
      const f = reva.editor.activeFile();
      if (!f) { reva.ui.toast('Open a file first', 'error'); return; }
      const lines = f.text.split('\n');
      const keep = lines.filter((l) => !/^\s*(\/\/|#|--|;)\s*TODO\b/.test(l));
      const removed = lines.length - keep.length;
      if (!removed) { reva.ui.toast('No full-line TODO comments in ' + f.name); return; }
      if (!(await reva.ui.confirm('Clear TODOs', 'Remove ' + removed + ' TODO comment line(s) from ' + f.name + '? You can undo with Ctrl+Z.', { okLabel: 'Remove', danger: true }))) return;
      reva.editor.setText(keep.join('\n'));
      reva.ui.toast('Removed ' + removed + ' TODO line(s)');
    },
  });

  // onBeforeSend sees every outgoing message and may modify it: here, a tiny guard that warns about huge pastes.
  reva.chat.onBeforeSend((text) => {
    if (text.length > 60000) { reva.ui.toast('That message is very long (' + text.length + ' characters)', 'error'); }
  });
};
