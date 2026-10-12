// Hello World - the smallest useful Reva plugin.
//
// A plugin is a script with `exports.activate(reva)`. Everything you register through `reva.*` is removed
// automatically when the plugin is disabled, uninstalled or reloaded - you rarely need `deactivate`.
// Edit this file and save: Reva reloads the plugin live.

exports.activate = (reva) => {
  let count = 0;

  // A status bar item (bottom bar). plugin.json also declares it, so it shows up before the plugin even starts;
  // registering the same id here replaces the placeholder and makes it interactive.
  const status = reva.ui.addStatusItem({
    id: 'hello',
    align: 'left',
    text: 'Hello',
    tooltip: 'Click to say hello',
    onClick: () => reva.commands.execute('sayHello'),
  });

  // A command. It appears in the command palette (Ctrl+Shift+P) because plugin.json declares it with a title,
  // and it is bound to Ctrl+Alt+H by the "keybinding" there.
  reva.commands.register('sayHello', () => {
    count++;
    reva.ui.toast('Hello from a Reva plugin! (' + count + ')');
    status.update({ text: 'Hello x' + count });
    reva.log.info('sayHello ran', count);
  });
};

exports.deactivate = () => {
  // optional - runs before the automatic clean-up
};
