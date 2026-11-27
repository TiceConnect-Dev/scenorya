import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND, formatCents, PAYMENT_METHODS, PaymentMethod } from '@scenorya/shared';
import { brandingDir } from '../system/settings.service';

export interface ReceiptData {
  association: { name: string; legalName: string | null; rna: string | null; siret: string | null; addressLine: string | null; postalCode: string | null; city: string | null; email: string | null; primaryColor: string };
  member: { number: number; firstName: string; lastName: string; addressLine: string | null; postalCode: string | null; city: string | null };
  due: { label: string; amountCents: number; periodStart: string; periodEnd: string | null; receiptNumber: string; receiptIssuedAt: Date };
  payments: { amountCents: number; method: string; paidAt: string; reference: string | null }[];
}

const frDate = (iso: string | Date) =>
  new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' })
    .format(typeof iso === 'string' ? new Date(`${iso}T12:00:00Z`) : iso)
    .replace(/^1 /, '1er ');
// pdfkit (polices standard WinAnsi) : remplace les espaces fines insécables non prises en charge.
const money = (c: number) => formatCents(c).replace(/[  ]/g, ' ');

/** Reçu de cotisation (non fiscal) au format A4. */
export function renderReceipt(data: ReceiptData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: `Reçu de cotisation ${data.due.receiptNumber}`, Author: data.association.name, Creator: `${BRAND.name} ${BRAND.edition}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const a = data.association;
    const accent = /^#[0-9a-f]{6}$/i.test(a.primaryColor) ? a.primaryColor : BRAND.colors.blue;
    const W = doc.page.width - 112;

    // En-tête : identité de l'association
    doc.rect(56, 48, 4, 64).fill(accent);
    doc.fillColor(BRAND.colors.navy).font('Helvetica-Bold').fontSize(18).text(a.name, 70, 50, { width: W - 200 });
    doc.font('Helvetica').fontSize(9).fillColor('#4f6077');
    const lines = [a.legalName && a.legalName !== a.name ? a.legalName : null, a.addressLine, [a.postalCode, a.city].filter(Boolean).join(' ') || null, a.email, a.rna ? `RNA : ${a.rna}` : null, a.siret ? `SIRET : ${a.siret}` : null].filter(Boolean) as string[];
    doc.text(lines.join('\n'), 70, doc.y + 2, { width: W - 200 });

    doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND.colors.navy).text('REÇU DE COTISATION', 56 + W - 180, 52, { width: 180, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor('#4f6077').text(`N° ${data.due.receiptNumber}\nÉmis le ${frDate(data.due.receiptIssuedAt)}`, 56 + W - 180, 66, { width: 180, align: 'right' });

    // Destinataire
    const m = data.member;
    doc.moveDown(4);
    const y0 = Math.max(doc.y, 150);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.colors.text).text(`${m.firstName} ${m.lastName.toUpperCase()}`, 320, y0);
    doc.font('Helvetica').fontSize(10).text([`Adhérent n° ${m.number}`, m.addressLine, [m.postalCode, m.city].filter(Boolean).join(' ')].filter(Boolean).join('\n'), 320);

    // Corps
    doc.moveDown(2.5);
    doc.font('Helvetica').fontSize(11).fillColor(BRAND.colors.text);
    const period = data.due.periodEnd ? `du ${frDate(data.due.periodStart)} au ${frDate(data.due.periodEnd)}` : `à compter du ${frDate(data.due.periodStart)}`;
    doc.text(`${a.name} atteste avoir reçu de ${m.firstName} ${m.lastName} la somme de ${money(data.due.amountCents)} au titre de la cotisation « ${data.due.label} », pour la période ${period}.`, 56, doc.y, { width: W, lineGap: 3 });

    // Tableau des règlements
    doc.moveDown(1.5);
    let y = doc.y;
    const cols = [56, 170, 330, 56 + W - 110];
    doc.rect(56, y, W, 22).fill('#f0f3f9');
    doc.fillColor(BRAND.colors.navy).font('Helvetica-Bold').fontSize(9);
    ['Date', 'Mode de règlement', 'Référence', 'Montant'].forEach((h, i) => doc.text(h, cols[i] + 6, y + 7, { width: i === 3 ? 104 : 150, align: i === 3 ? 'right' : 'left' }));
    y += 22;
    doc.font('Helvetica').fontSize(10).fillColor(BRAND.colors.text);
    for (const p of data.payments) {
      doc.text(frDate(p.paidAt), cols[0] + 6, y + 6, { width: 110 });
      doc.text(PAYMENT_METHODS[p.method as PaymentMethod] ?? p.method, cols[1] + 6, y + 6, { width: 150 });
      doc.text(p.reference ?? '—', cols[2] + 6, y + 6, { width: 150 });
      doc.text(money(p.amountCents), cols[3] + 6, y + 6, { width: 104, align: 'right' });
      y += 22;
      doc.moveTo(56, y).lineTo(56 + W, y).strokeColor('#d5dce8').lineWidth(0.5).stroke();
    }
    doc.font('Helvetica-Bold').text('Total réglé', cols[2] + 6, y + 8, { width: 150 });
    doc.text(money(data.payments.reduce((s, p) => s + p.amountCents, 0)), cols[3] + 6, y + 8, { width: 104, align: 'right' });

    // Mentions
    doc.font('Helvetica').fontSize(8.5).fillColor('#4f6077');
    doc.text(
      "Ce reçu atteste du paiement d'une cotisation. Il ne constitue pas un reçu fiscal au titre des articles 200, 238 bis et 978 du code général des impôts (formulaire Cerfa n° 11580) : seules les associations habilitées peuvent délivrer de tels reçus.",
      56, y + 50, { width: W, lineGap: 2 },
    );

    // Pied de page : signature Scenorya
    const logo = join(brandingDir(), 'derived', 'logos', 'scenorya-horizontal-small.png');
    const fy = doc.page.height - 80;
    if (existsSync(logo)) doc.image(logo, 56, fy, { height: 24 });
    doc.fontSize(7.5).fillColor('#8090a4').text(`Document généré par ${BRAND.name} — ${BRAND.signature}`, 56 + W - 260, fy + 8, { width: 260, align: 'right' });
    doc.end();
  });
}
