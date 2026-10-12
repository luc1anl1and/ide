const { contextBridge, ipcRenderer, webUtils } = require('electron');

const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  settings: { get: inv('settings:get'), set: inv('settings:set'), reveal: inv('settings:reveal') },
  claude: { models: inv('claude:models') },
  keys: { catalog: inv('keys:catalog'), list: inv('keys:list'), set: inv('keys:set') },
  custom: { test: inv('custom:test'), models: inv('custom:models') },
  agent: { start: inv('agent:start'), write: inv('agent:write'), kill: inv('agent:kill'), rewind: inv('agent:rewind') },
  providers: { detect: inv('providers:detect'), commandFor: inv('providers:commandFor'), install: inv('providers:install'), login: inv('providers:login'), logout: inv('providers:logout'), info: inv('providers:info'), codexKey: inv('providers:codexKey') },
  usage: { claude: inv('usage:claude') },
  voice: { status: inv('voice:status'), ensure: inv('voice:ensure'), transcribe: inv('voice:transcribe') },
  mcp: { list: inv('mcp:list'), get: inv('mcp:get'), add: inv('mcp:add'), addJson: inv('mcp:addJson'), remove: inv('mcp:remove'), login: inv('mcp:login') },
  fs: {
    readdir: inv('fs:readdir'), read: inv('fs:read'), write: inv('fs:write'), create: inv('fs:create'), rename: inv('fs:rename'),
    trash: inv('fs:trash'), reveal: inv('fs:reveal'), openExternal: inv('fs:openExternal'), search: inv('fs:search'), readB64: inv('fs:readB64'),
    readBytes: inv('fs:readBytes'), list: inv('fs:list'),
    pathOf: (file) => webUtils.getPathForFile(file),
  },
  fonts: { list: inv('fonts:list'), install: inv('fonts:install') },
  dialog: { fonts: inv('dialog:fonts'), folder: inv('dialog:folder'), images: inv('dialog:images'), media: inv('dialog:media'), file: inv('dialog:file') },
  clipboard: { readImage: inv('clipboard:readImage') },
  ws: { watch: inv('ws:watch') },
  sessions: { all: inv('sessions:all'), read: inv('sessions:read') },
  ports: { scan: inv('ports:scan'), dockDevTools: inv('ports:dockDevTools'), closeDevTools: inv('ports:closeDevTools'), capture: inv('ports:capture'), trust: inv('ports:trust') },
  ide: { reply: inv('ide:reply') },
  plugins: require('./plugins-preload')(ipcRenderer),
  chats: { save: inv('chats:save'), read: inv('chats:read'), delete: inv('chats:delete'), dir: inv('chats:dir') },
  cp: { mark: inv('cp:mark'), plan: inv('cp:plan'), restore: inv('cp:restore'), changes: inv('cp:changes'), base: inv('cp:base'), revertFile: inv('cp:revertFile') },
  pty: { shells: inv('pty:shells'), create: inv('pty:create'), write: inv('pty:write'), resize: inv('pty:resize'), kill: inv('pty:kill'), cwd: inv('pty:cwd'), attach: inv('pty:attach'), list: inv('pty:list') },
  win: { overlay: inv('win:overlay'), zoom: inv('win:zoom') },
  app: { ready: inv('app:ready'), getLogo: inv('app:getLogo') },
  notify: inv('app:notify'),
  pet: { config: inv('pet:config'), list: inv('pet:list'), import: inv('pet:import'), importFolder: inv('pet:importFolder'), remove: inv('pet:remove'), folder: inv('pet:folder'), show: inv('pet:show'), state: (s) => ipcRenderer.send('pet:state', s), event: (e) => ipcRenderer.send('pet:event', e), revoke: inv('pet:revoke') },
  pop: { open: inv('pop:open'), close: inv('pop:close'), focus: inv('pop:focus'), call: inv('pop:call'), broadcast: inv('pop:broadcast'), overlay: inv('pop:overlay') },
  on: (ch, cb) => { const f = (_e, p) => cb(p); ipcRenderer.on(ch, f); return () => ipcRenderer.removeListener(ch, f); },
});
