import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { loadConfig } from '../config';

/** Répertoires du stockage Drive (dans le volume de données). */
export const driveDirs = () => {
  const root = loadConfig().dataDir;
  return { files: join(root, 'files'), tmp: join(root, 'tmp') };
};

export const blobPath = (sha: string) => {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('Empreinte invalide');
  return join(driveDirs().files, sha.slice(0, 2), sha.slice(2, 4), sha);
};

/** Empreinte SHA-256, taille et premiers octets (détection des exécutables déguisés). */
export async function hashFile(path: string): Promise<{ sha256: string; size: number; head: Buffer }> {
  const h = createHash('sha256');
  let size = 0;
  let head = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    const b = chunk as Buffer;
    if (head.length < 16) head = Buffer.concat([head, b.subarray(0, 16 - head.length)]);
    h.update(b);
    size += b.length;
  }
  return { sha256: h.digest('hex'), size, head };
}

/** Range le fichier temporaire à son adresse définitive (ou le supprime si le contenu existe déjà). */
export async function storeBlob(tmpPath: string, sha: string) {
  const dest = blobPath(sha);
  const exists = await stat(dest).then((s) => s.isFile(), () => false);
  if (exists) {
    await unlink(tmpPath).catch(() => undefined);
    return;
  }
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(tmpPath, dest);
  } catch {
    // Volumes différents : copie puis suppression.
    await copyFile(tmpPath, dest);
    await unlink(tmpPath).catch(() => undefined);
  }
}

export async function removeBlob(sha: string) {
  await unlink(blobPath(sha)).catch(() => undefined);
}

export async function blobExists(sha: string) {
  return stat(blobPath(sha)).then((s) => s.isFile(), () => false);
}

/** Extensions refusées : programmes et scripts exécutables. */
const BLOCKED = new Set([
  'exe', 'dll', 'com', 'bat', 'cmd', 'msi', 'msp', 'mst', 'scr', 'pif', 'cpl', 'gadget', 'hta', 'jar', 'jse', 'vbs', 'vbe',
  'wsf', 'wsh', 'ws', 'ps1', 'psm1', 'psd1', 'ps1xml', 'reg', 'lnk', 'inf', 'sys', 'drv', 'sh', 'bash', 'zsh', 'csh', 'ksh',
  'command', 'app', 'apk', 'appx', 'msix', 'deb', 'rpm', 'dmg', 'pkg', 'run', 'elf', 'bin', 'so', 'dylib', 'iso', 'img', 'vhd', 'vhdx',
]);

export function extensionOf(name: string) {
  return extname(name).slice(1).toLowerCase();
}

/** Refuse les exécutables, y compris renommés (en-têtes PE « MZ », ELF, Mach-O, script « #! »). */
export function blockedReason(name: string, head: Buffer): string | null {
  const ext = extensionOf(name);
  if (BLOCKED.has(ext)) return `Les fichiers « .${ext} » (programmes ou scripts exécutables) ne sont pas acceptés.`;
  // Double extension trompeuse : « facture.pdf.exe » est déjà couvert ; « photo.exe.jpg » ne l'est pas, d'où l'analyse du contenu.
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return 'Ce fichier est un programme Windows déguisé : il est refusé.';
  if (head.length >= 4 && head.readUInt32BE(0) === 0x7f454c46) return 'Ce fichier est un programme exécutable : il est refusé.';
  if (head.length >= 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(head.readUInt32BE(0))) {
    return 'Ce fichier est un programme exécutable : il est refusé.';
  }
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21 && !['txt', 'md', 'csv', 'py', 'pl', 'rb'].includes(ext)) {
    return 'Ce fichier est un script exécutable : il est refusé.';
  }
  return null;
}

/** Type MIME déduit de l'extension (le type déclaré par le navigateur n'est pas fiable). */
const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', ico: 'image/x-icon',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf', zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', gz: 'application/gzip',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', ics: 'text/calendar', vcf: 'text/vcard',
};

export const mimeOf = (name: string) => MIME[extensionOf(name)] ?? 'application/octet-stream';

/**
 * Types affichables dans le navigateur sans risque. Le SVG et le HTML, qui peuvent contenir
 * du script, sont toujours téléchargés.
 */
const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'video/mp4', 'video/webm']);
export const canPreview = (mime: string) => INLINE.has(mime);

/** En-têtes de réponse d'un fichier servi (aperçu ou téléchargement). */
export function fileHeaders(name: string, mime: string, size: number, inline: boolean): Record<string, string> {
  const asInline = inline && canPreview(mime);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const headers: Record<string, string> = {
    'Content-Type': asInline ? (mime.startsWith('text/') ? `${mime}; charset=utf-8` : mime) : 'application/octet-stream',
    'Content-Length': String(size),
    'Content-Disposition': `${asInline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  // Le lecteur PDF du navigateur ne fonctionne pas dans un document « sandbox » ; les autres types y sont confinés.
  headers['Content-Security-Policy'] = mime === 'application/pdf' && asInline
    ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'"
    : "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'";
  return headers;
}

/** Nom de fichier propre : sans séparateurs ni caractères de contrôle. */
export function cleanName(raw: string, max = 255) {
  const n = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\]/g, '_').replace(/\s+/g, ' ').trim();
  return n.slice(0, max) || 'fichier';
}

/** « Rapport.pdf » → « Rapport (2).pdf ». */
export function numbered(name: string, n: number) {
  const ext = extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  return `${base} (${n})${ext}`;
}

export async function readHead(path: string, n = 16) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
