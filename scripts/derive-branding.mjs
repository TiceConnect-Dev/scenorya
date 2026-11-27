// Dérive du pack officiel des variantes RECADRÉES (suppression des marges
// transparentes) pour l'affichage à petite taille. Aucune modification du
// dessin, des couleurs ni des proportions : les fichiers d'origine restent
// intacts dans branding/ ; les dérivés sont écrits dans branding/derived/.
import sharp from 'sharp';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'branding');
const out = join(src, 'derived');
const modules = JSON.parse(readFileSync(join(src, 'modules.json'), 'utf8'));

async function trim(input, output, { square = false, margin = 0.06 } = {}) {
  const { data, info } = await sharp(input).trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
  const side = Math.max(info.width, info.height);
  const pad = Math.round((square ? side : Math.max(info.width, info.height)) * margin);
  const w = square ? side : info.width;
  const h = square ? side : info.height;
  mkdirSync(dirname(output), { recursive: true });
  await sharp(data)
    .extend({
      top: pad + Math.floor((h - info.height) / 2), bottom: pad + Math.ceil((h - info.height) / 2),
      left: pad + Math.floor((w - info.width) / 2), right: pad + Math.ceil((w - info.width) / 2),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toFile(output);
}

for (const m of modules) {
  await trim(join(src, m.icon), join(out, 'modules', m.id, 'icon.png'), { square: true, margin: 0.04 });
  await trim(join(src, m.logo), join(out, 'modules', m.id, 'logo.png'), { margin: 0.03 });
  await trim(join(src, m.logoDark), join(out, 'modules', m.id, 'logo-dark.png'), { margin: 0.03 });
}
for (const f of ['scenorya-horizontal.png', 'scenorya-dark.png']) {
  await trim(join(src, 'logos', f), join(out, 'logos', f), { margin: 0.02 });
}
// Variantes réduites (documents PDF et e-mails : poids limité).
for (const f of ['scenorya-horizontal.png', 'scenorya-dark.png']) {
  await sharp(join(out, 'logos', f)).resize({ width: 640 }).png({ compressionLevel: 9, palette: true }).toFile(join(out, 'logos', f.replace('.png', '-small.png')));
}
console.log('Variantes recadrées générées dans branding/derived/');
