// Preload half of the plugin system: returns the `api.plugins` object.
//   preload.js:   plugins: require('./plugins-preload')(ipcRenderer),
'use strict';
module.exports = (ipcRenderer) => {
  const inv = (ch) => (a) => ipcRenderer.invoke(ch, a);
  return {
    list: inv('plugins:list'), setEnabled: inv('plugins:setEnabled'), setMode: inv('plugins:setMode'), grant: inv('plugins:grant'),
    install: inv('plugins:install'), installBuiltin: inv('plugins:installBuiltin'), uninstall: inv('plugins:uninstall'),
    create: inv('plugins:create'), templates: inv('plugins:templates'), readMain: inv('plugins:readMain'), readFile: inv('plugins:readFile'),
    openFolder: inv('plugins:openFolder'), storage: inv('plugins:storage'), fetch: inv('plugins:fetch'), setTools: (list) => ipcRenderer.invoke('plugins:tools:set', { list }),
  };
};
