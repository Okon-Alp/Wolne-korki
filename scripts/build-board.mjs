// Buduje tablicę (Excalidraw + React) do public/board/. Uruchom: npm run build
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public/board');
fs.rmSync(out, { recursive: true, force: true });

// Excalidraw jako zapasowe źródło czcionek podaje CDN esm.sh. Podmieniamy je na nasz serwer,
// żeby przeglądarka nigdy nie sięgała na zewnątrz.
const noCdn = {
  name: 'no-cdn',
  setup(b) {
    b.onLoad({ filter: /@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/].*\.js$/ }, async (args) => {
      let code = await fs.promises.readFile(args.path, 'utf8');
      code = code.replace(/`https:\/\/esm\.sh\/\$\{[^\n]*?\}\/dist\/prod\/`/g, '(window.location.origin+"/board/")');
      // Paczka zawiera konfigurację Firebase serwisu excalidraw.com (z kluczem API), której nigdzie nie używa.
      // Wycinamy ją, żeby nie trafiała do naszego repozytorium (skanery sekretów słusznie na nią reagują).
      code = code.replace(/VITE_APP_FIREBASE_CONFIG:'[^']*'/g, "VITE_APP_FIREBASE_CONFIG:'{}'");
      return { contents: code, loader: 'js' };
    });
  },
};

const result = await build({
  metafile: true,
  plugins: [noCdn],
  entryPoints: { board: path.join(root, 'board-src/board.jsx') },
  outdir: out,
  bundle: true,
  splitting: true,
  format: 'esm',
  target: ['es2022', 'chrome100', 'firefox100', 'safari16'],
  minify: true,
  jsx: 'automatic',
  conditions: ['production'],
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  loader: { '.woff2': 'file', '.png': 'file', '.svg': 'file' },
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"' },
  legalComments: 'linked',
  logLevel: 'warning',
});

// Czcionki serwowane z własnego serwera (bez CDN). Przeglądarka pobiera tylko potrzebne fragmenty.
const fontsSrc = path.join(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
fs.cpSync(fontsSrc, path.join(out, 'fonts'), { recursive: true });

const COPYRIGHT = { '@excalidraw/excalidraw': 'Copyright (c) 2020 Excalidraw' };
const MIT_TEXT = `MIT License

{{holder}}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// Licencje wszystkich pakietów, które trafiły do paczki (MIT i inne wymagają dołączenia tekstu).
const pkgs = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replace(/\\/g, '/'));
  if (!m) continue;
  const dir = path.join(root, input.slice(0, input.indexOf(m[0]) + m[0].length));
  if (pkgs.has(dir)) continue;
  let pj = {};
  try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* brak */ }
  const lic = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)([.-]|$)/i.test(f));
  const license = pj.license || (pj.licenses || []).map((l) => l.type).join(' OR ') || '?';
  let text = lic ? fs.readFileSync(path.join(dir, lic), 'utf8').trim() : '';
  if (!text && /MIT/.test(license)) {
    // Pakiet nie ma pliku licencji: dołączamy standardowy tekst MIT z właścicielem praw z metadanych.
    const holder = COPYRIGHT[pj.name] || `Copyright (c) ${typeof pj.author === 'string' ? pj.author : pj.author?.name || `${pj.name} authors`}`;
    text = MIT_TEXT.replace('{{holder}}', holder);
  }
  pkgs.set(dir, { name: pj.name || m[1], version: pj.version || '', license, text });
}
const list = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(path.join(out, 'THIRD_PARTY_LICENSES.txt'),
  'Biblioteki zawarte w tablicy (public/board) i ich licencje.\n\n' +
  list.map((p) => `==== ${p.name}@${p.version} (${p.license}) ====\n\n${p.text || '(pakiet nie zawiera pliku licencji; licencja wg package.json: ' + p.license + ')'}\n`).join('\n'));
console.log(`Licencje: ${list.length} pakietów (${[...new Set(list.map((p) => p.license))].join(', ')})`);

let total = 0;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p); else total += fs.statSync(p).size;
});
walk(out);
console.log(`Tablica zbudowana: public/board (${(total / 1048576).toFixed(1)} MB)`);
