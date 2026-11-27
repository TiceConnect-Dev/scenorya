import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '@scenorya/shared';
import { brandingDir } from '../system/settings.service';

/** Format carte bancaire ISO/IEC 7810 ID-1 : 85,60 × 53,98 mm. */
const MM = 72 / 25.4;
export const CARD_W = 85.6 * MM;
export const CARD_H = 53.98 * MM;

export interface CardData {
  association: { name: string; primaryColor: string };
  member: { number: number; firstName: string; lastName: string; category: string };
  validUntil: string | null;
  verifyUrl: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  actif: 'Membre actif', benevole: 'Bénévole', responsable: 'Responsable', bienfaiteur: 'Membre bienfaiteur', honneur: "Membre d'honneur", ancien: 'Ancien membre',
};
const frDate = (iso: string) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeZone: 'Europe/Paris' }).format(new Date(`${iso}T12:00:00Z`));

async function drawCard(doc: PDFKit.PDFDocument, x: number, y: number, c: CardData) {
  const accent = /^#[0-9a-f]{6}$/i.test(c.association.primaryColor) ? c.association.primaryColor : BRAND.colors.blue;
  doc.save();
  doc.roundedRect(x, y, CARD_W, CARD_H, 8).lineWidth(0.6).strokeColor('#b3bfd1').stroke();
  doc.rect(x, y, CARD_W, 30).clip();
  doc.roundedRect(x, y, CARD_W, 40, 8).fill(accent);
  doc.restore();
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text(c.association.name, x + 10, y + 10, { width: CARD_W - 20, height: 14, ellipsis: true });
  doc.fillColor(BRAND.colors.navy).font('Helvetica').fontSize(6.5).text("CARTE D'ADHÉRENT", x + 10, y + 38);
  doc.font('Helvetica-Bold').fontSize(11).text(`${c.member.firstName} ${c.member.lastName.toUpperCase()}`, x + 10, y + 48, { width: CARD_W - 100, height: 28, ellipsis: true });
  doc.font('Helvetica').fontSize(7.5).fillColor('#4f6077');
  doc.text(`N° ${c.member.number}`, x + 10, y + 78);
  doc.text(CATEGORY_LABELS[c.member.category] ?? c.member.category, x + 10, y + 89, { width: CARD_W - 100 });
  doc.text(c.validUntil ? `Valide jusqu'au ${frDate(c.validUntil)}` : 'Validité : à vérifier en ligne', x + 10, y + 100, { width: CARD_W - 100 });
  // QR : URL de vérification avec un jeton opaque (aucune donnée personnelle).
  const qr = await QRCode.toBuffer(c.verifyUrl, { errorCorrectionLevel: 'M', margin: 1, width: 220, color: { dark: BRAND.colors.navy, light: '#ffffff' } });
  doc.image(qr, x + CARD_W - 84, y + 38, { width: 74 });
  const logo = join(brandingDir(), 'derived', 'logos', 'scenorya-horizontal-small.png');
  if (existsSync(logo)) doc.image(logo, x + CARD_W - 84, y + CARD_H - 20, { width: 74 });
}

/** Une carte par page (format carte) ou planche A4 de 10 cartes à découper. */
export function renderCards(cards: CardData[], layout: 'single' | 'sheet'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc =
      layout === 'single'
        ? new PDFDocument({ size: [CARD_W + 20, CARD_H + 20], margin: 0, autoFirstPage: false })
        : new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
    doc.info.Title = "Cartes d'adhérent";
    doc.info.Creator = `${BRAND.name} ${BRAND.edition}`;
    const chunks: Buffer[] = [];
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    (async () => {
      if (layout === 'single') {
        for (const c of cards) {
          doc.addPage();
          await drawCard(doc, 10, 10, c);
        }
      } else {
        const perPage = 10;
        const gx = (595.28 - 2 * CARD_W) / 3;
        const gy = (841.89 - 5 * CARD_H) / 6;
        for (let i = 0; i < cards.length; i++) {
          if (i % perPage === 0) doc.addPage();
          const k = i % perPage;
          await drawCard(doc, gx + (k % 2) * (CARD_W + gx), gy + Math.floor(k / 2) * (CARD_H + gy), cards[i]);
        }
      }
      doc.end();
    })().catch(reject);
  });
}
