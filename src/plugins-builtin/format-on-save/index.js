// Format on Save - uses Monaco's built-in formatter (reva.editor.format) right before a file is written.
//
// onWillSave handlers run before the file is saved (up to 5 s each) so the formatted text is what lands on disk.
// This needs Reva's save hook: `await RevaPlugins.beforeSave(path, model)` in saveFile() (see the plugin docs).

exports.activate = (reva) => {
  const status = reva.ui.addStatusItem({ id: 'fos', align: 'right', text: '', tooltip: 'Format on save - click to toggle', onClick: () => reva.commands.execute('toggle') });
  const enabled = () => reva.settings.get('enabled', true);
  const langs = () => String(reva.settings.get('languages', '')).split(',').map((s) => s.trim()).filter(Boolean);
  const paint = () => status.update({ text: enabled() ? 'Format on save' : '' });

  reva.editor.onWillSave(async ({ language, isActive }) => {
    if (!enabled() || !isActive || !langs().includes(language)) return;   // format() works on the visible editor
    await reva.editor.format();
  });

  reva.commands.register('toggle', () => {
    reva.settings.set('enabled', !enabled());
    reva.ui.toast('Format on save ' + (enabled() ? 'enabled' : 'disabled'));
  });
  reva.settings.onDidChange(paint);
  paint();
};
