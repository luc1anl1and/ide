#!/usr/bin/env node
'use strict';
// Builds release/Reva-Setup-<version>.exe: compiles installer/Setup.cs with the .NET Framework compiler that ships with
// Windows (no SDK needed) and appends the app (release/Reva-<version>-portable.zip) as its payload.
//   exe layout: [setup program][payload.zip][payload length: int64 LE][magic "REVASETP"]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const rel = path.join(root, 'release');
const zip = path.join(rel, `hyper-${pkg.version}-portable.zip`);
const out = path.join(rel, `hyper-Setup-${pkg.version}.exe`);
if (process.platform !== 'win32') { console.log('setup: Windows only, skipped'); process.exit(0); }
if (!fs.existsSync(zip)) { console.error('setup: missing ' + zip + ' (run electron-builder first)'); process.exit(1); }

const win = process.env.windir || 'C:\\Windows';
const csc = [path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find((p) => fs.existsSync(p));
if (!csc) { console.error('setup: the .NET Framework compiler (csc.exe) was not found'); process.exit(1); }

const tmp = path.join(rel, '.setup-build'); fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, 'version.txt'), pkg.version);
const stub = path.join(tmp, 'stub.exe');
const args = ['/nologo', '/target:winexe', '/optimize+', '/platform:anycpu', '/out:' + stub,
  '/win32icon:' + path.join(root, 'src', 'renderer', 'assets', 'icon.ico'), '/win32manifest:' + path.join(root, 'installer', 'setup.manifest'),
  '/resource:' + path.join(root, 'src', 'renderer', 'assets', 'logo.png') + ',Reva.Logo', '/resource:' + path.join(tmp, 'version.txt') + ',Reva.Version',
  ...['System.Windows.Forms', 'System.Drawing', 'System.IO.Compression', 'System.IO.Compression.FileSystem'].map((r) => '/r:' + r + '.dll'),
  path.join(root, 'installer', 'Setup.cs')];
try { execFileSync(csc, args, { stdio: 'inherit' }); } catch { console.error('setup: compilation failed'); process.exit(1); }

const payload = fs.readFileSync(zip);
const trailer = Buffer.alloc(16); trailer.writeBigInt64LE(BigInt(payload.length), 0); trailer.write('REVASETP', 8, 'ascii');
fs.writeFileSync(out, Buffer.concat([fs.readFileSync(stub), payload, trailer]));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`setup: ${path.relative(root, out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);