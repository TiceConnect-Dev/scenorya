import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { BRAND } from '@scenorya/shared';

/** Planche A4 de 24 étiquettes (3 × 8, 70 × 37 mm) : QR code vers la fiche, nom, référence. */
export async function labelsPdf(association: string, items: { name: string; reference: string | null; location: string | null; url: string }[]) {
  const d = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'Étiquettes de matériel', Creator: BRAND.name } });
  const chunks: Buffer[] = [];
  d.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { d.on('end', () => resolve(Buffer.concat(chunks))); d.on('error', reject); });
  const mm = 72 / 25.4;
  const W = 70 * mm, H = 37 * mm, top = (297 - 8 * 37) / 2 * mm;
  for (let i = 0; i < items.length; i++) {
    if (i > 0 && i % 24 === 0) d.addPage();
    const k = i % 24, x = (k % 3) * W, y = top + Math.floor(k / 3) * H;
    const it = items[i];
    const qr = await QRCode.toBuffer(it.url, { errorCorrectionLevel: 'M', margin: 0, width: 200 });
    d.image(qr, x + 3 * mm, y + 4 * mm, { width: 29 * mm });
    const tx = x + 35 * mm, tw = W - 38 * mm;
    d.fillColor(BRAND.colors.navy).font('Helvetica-Bold').fontSize(9).text(it.name, tx, y + 5 * mm, { width: tw, height: 14 * mm, ellipsis: true });
    if (it.reference) d.font('Helvetica-Bold').fontSize(11).fillColor('#000').text(it.reference, tx, y + 20 * mm, { width: tw, lineBreak: false, ellipsis: true });
    d.font('Helvetica').fontSize(6.5).fillColor('#4f6077').text([it.location, association].filter(Boolean).join(' · '), tx, y + 28 * mm, { width: tw, height: 7 * mm, ellipsis: true });
  }
  d.end();
  return done;
}
