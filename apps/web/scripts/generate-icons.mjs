// Génère favicon et icônes PWA à partir de l'icône principale du pack officiel
// (branding/logos/scenorya-icon.png). Aucune recréation du logo : simple redimensionnement.
import sharp from 'sharp';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = join(root, 'branding', 'logos', 'scenorya-icon.png');
const out = join(root, 'apps', 'web', 'public', 'icons');
mkdirSync(out, { recursive: true });

for (const size of [16, 32, 48, 72, 96, 128, 144, 152, 180, 192, 256, 384, 512]) {
  await sharp(src).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(join(out, `icon-${size}.png`));
}
// Icône « maskable » : l'emblème est placé dans la zone de sécurité (80 %) sur fond bleu nuit.
const inner = await sharp(src).resize(400, 400, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#102540' } })
  .composite([{ input: inner, gravity: 'center' }]).png().toFile(join(out, 'maskable-512.png'));
await sharp(join(out, 'icon-180.png')).flatten({ background: '#FFFFFF' }).toFile(join(out, 'apple-touch-icon.png'));
copyFileSync(join(root, 'branding', 'favicon.ico'), join(root, 'apps', 'web', 'public', 'favicon.ico'));
console.log('Icônes générées dans', out);
