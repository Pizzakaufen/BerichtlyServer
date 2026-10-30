// Übernimmt die benötigten Quelldateien aus einer Libraries.dev-Kopie (MIT, © 2026 Jakub Antalik) als
// browserfähiges JavaScript nach web/vendor/ – ohne Build-Werkzeug: Node entfernt nur die TypeScript-Typen
// (module.stripTypeScriptTypes, Node ≥ 22.13), relative Importe erhalten die Endung .js. Der Code selbst bleibt
// unverändert. Aufruf: node scripts/vendor-libraries.mjs <Pfad zu Libraries.dev>
import { stripTypeScriptTypes } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const src = process.argv[2];
if (!src) {
  console.error('Pfad zu Libraries.dev fehlt.');
  process.exit(1);
}
const out = join(import.meta.dirname, '..', 'web', 'vendor');

const files = {
  'thinking-orbs': [
    'src/presets.ts', 'src/engine/core.ts', 'src/engine/profiles.ts', 'src/engine/registry.ts', 'src/engine/orbits.ts',
    'src/engine/lattice.ts', 'src/engine/web.ts', 'src/engine/braid.ts', 'src/engine/ribbon.ts', 'src/engine/morph.ts'
  ],
  'border-beam': ['src/styles.ts'],
};

for (const [pkg, list] of Object.entries(files)) {
  for (const rel of list) {
    const ts = readFileSync(join(src, 'packages', pkg, rel), 'utf8');
    let js = stripTypeScriptTypes(ts, { mode: 'strip' });
    // './core' → './core.js' (Browser-Module brauchen die Dateiendung).
    js = js.replace(/(from\s+['"])(\.{1,2}\/[^'"]+?)(['"])/g, (_m, a, p, b) => `${a}${p.endsWith('.js') ? p : p + '.js'}${b}`);
    const target = join(out, pkg, rel.replace(/^src\//, '').replace(/\.ts$/, '.js'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `// Aus Libraries.dev (${pkg}, MIT) – nur Typen entfernt, siehe scripts/vendor-libraries.mjs.\n${js}`);
  }
  copyFileSync(join(src, 'packages', pkg, 'LICENSE'), join(out, pkg, 'LICENSE'));
}
console.log('Vendor-Dateien aktualisiert:', out);
