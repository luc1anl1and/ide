// Word Count - a status bar item that follows the editor, plus an editor action.
// Shows how to react to editor events and how to read a plugin setting (see "settings" in plugin.json).

exports.activate = (reva) => {
  const status = reva.ui.addStatusItem({
    id: 'count', align: 'right', text: '', tooltip: 'Words in the file (or selection). Click for details.',
    onClick: () => reva.commands.execute('showCount'),
  });

  // words = runs of non-whitespace characters
  const stats = (text) => ({ words: (text.match(/\S+/g) || []).length, chars: text.length, lines: text ? text.split('\n').length : 0 });

  function update() {
    const f = reva.editor.activeFile();                    // needs permission "workspace.read"
    if (!f) { status.update({ text: '' }); return; }       // empty text hides the item
    const useSel = !f.selection.empty;
    const s = stats(useSel ? f.selection.text : f.text);
    let t = s.words + (s.words === 1 ? ' word' : ' words');
    if (reva.settings.get('showChars', false)) t += ' · ' + s.chars + ' chars';
    status.update({ text: (useSel ? 'Selection: ' : '') + t });
  }

  // These callbacks are wrapped by Reva: an exception is logged and toasted, never breaks the editor.
  reva.editor.onDidChangeActive(update);
  reva.editor.onDidChangeText(update);        // debounced by Reva
  reva.editor.onDidChangeSelection(update);
  reva.settings.onDidChange(update);           // when the user flips "Show characters" in the plugin manager
  update();

  const details = () => {
    const f = reva.editor.activeFile();
    if (!f) return reva.ui.toast('Open a file first');
    const s = stats(f.text);
    reva.ui.toast(f.name + ': ' + s.words + ' words, ' + s.chars + ' characters, ' + s.lines + ' lines');
  };
  reva.commands.register('showCount', details);

  // An editor action shows up in the editor's right-click menu and can have a shortcut.
  reva.editor.registerAction({ id: 'wordCountAction', label: 'Word Count: Show Details', keybinding: 'Ctrl+Alt+W', run: details });
};
