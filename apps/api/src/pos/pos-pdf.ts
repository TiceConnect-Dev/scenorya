import PDFDocument from 'pdfkit';
import { BRAND } from '@scenorya/shared';
import { doc, footer, GovAssociation, header, title } from '../asso/governance-pdf';
import { euros, METHOD, SessionSummary } from './pos-core';

const dt = (d: Date) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(d);

/** Rapport de clôture (Z) d'une session de caisse. */
export async function zReport(a: GovAssociation, s: { number: number; register: string; openedAt: Date; closedAt: Date | null; openedBy: string | null; closedBy: string | null; openingFloatCents: number; countedCashCents: number | null; expectedCashCents: number | null; cashCount: Record<string, number> | null; notes: string | null }, sum: SessionSummary) {
  const { d, done } = doc(`Clôture de caisse n° ${s.number}`);
  header(d, a);
  title(d, `Clôture de caisse n° ${s.number}`, `${s.register} — ${s.closedAt ? 'session close' : 'SESSION EN COURS (rapport X)'}`);
  const kv = (k: string, v: string, bold = false) => {
    const y = d.y;
    d.font('Helvetica').fontSize(10).fillColor('#4f6077').text(k, 56, y, { width: 290 });
    d.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#1d2b3f').text(v, 346, y, { width: 193, align: 'right' });
    d.moveDown(0.3);
  };
  const section = (t: string) => { d.moveDown(0.6); d.font('Helvetica-Bold').fontSize(12).fillColor(BRAND.colors.navy).text(t, 56); d.moveDown(0.3); };
  kv('Ouverture', `${dt(s.openedAt)}${s.openedBy ? ` — ${s.openedBy}` : ''}`);
  if (s.closedAt) kv('Clôture', `${dt(s.closedAt)}${s.closedBy ? ` — ${s.closedBy}` : ''}`);
  section('Ventes');
  kv('Ventes validées', String(sum.salesCount));
  kv('Chiffre d’affaires', euros(sum.totalCents), true);
  kv('Panier moyen', euros(sum.averageCents));
  kv('Ventes annulées', `${sum.voidedCount} (${euros(sum.voidedCents)})`);
  section('Règlements');
  for (const [m, c] of Object.entries(sum.byMethod)) kv(METHOD[m] ?? m, euros(c));
  if (!Object.keys(sum.byMethod).length) kv('Aucun règlement', '—');
  section('Espèces');
  kv('Fond de caisse', euros(s.openingFloatCents));
  kv('Encaissements en espèces', euros(sum.byMethod.cash ?? 0));
  if (sum.cashIn) kv('Apports', euros(sum.cashIn));
  if (sum.cashOut) kv('Retraits', `− ${euros(sum.cashOut)}`);
  kv('Espèces attendues', euros(s.expectedCashCents ?? sum.expectedCashCents), true);
  if (s.countedCashCents != null) {
    kv('Espèces comptées', euros(s.countedCashCents), true);
    const diff = s.countedCashCents - (s.expectedCashCents ?? sum.expectedCashCents);
    kv('Écart', diff === 0 ? 'aucun' : `${diff > 0 ? '+' : '−'} ${euros(Math.abs(diff))}`, true);
  }
  if (s.cashCount && Object.keys(s.cashCount).length) {
    d.moveDown(0.3);
    d.font('Helvetica').fontSize(8.5).fillColor('#4f6077').text('Comptage : ' + Object.entries(s.cashCount).filter(([, n]) => n > 0).sort((x, y) => Number(y[0]) - Number(x[0])).map(([v, n]) => `${n} × ${euros(Number(v))}`).join(' ; '), 56, d.y, { width: 483 });
  }
  if (sum.moves.length) d.moveDown(0.3);
  for (const m of sum.moves) kv(`${m.kind === 'in' ? 'Apport' : 'Retrait'} ${dt(m.createdAt)}${m.reason ? ` — ${m.reason}` : ''}`, euros(m.amountCents));
  section('Détail des produits');
  for (const p of sum.products) {
    if (d.y > 740) d.addPage();
    kv(`${p.qty} × ${p.name}${p.category ? ` (${p.category})` : ''}`, euros(p.cents));
  }
  if (!sum.products.length) kv('Aucune vente', '—');
  if (s.notes) { section('Observations'); d.font('Helvetica').fontSize(10).fillColor('#1d2b3f').text(s.notes, 56, d.y, { width: 483 }); }
  footer(d);
  d.end();
  return done;
}

/** Ticket de caisse au format 80 mm. */
export async function receiptPdf(a: { name: string; address?: string | null; city?: string | null }, sale: { number: string; createdAt: Date; totalCents: number; status: string; register: string; seller: string | null }, lines: { name: string; quantity: number; unitPriceCents: number }[], payments: { method: string; amountCents: number; tenderedCents: number | null }[]) {
  const mm = 72 / 25.4, W = 80 * mm;
  const height = (60 + lines.length * 5 + payments.length * 5) * mm;
  const d = new PDFDocument({ size: [W, height], margin: 4 * mm, info: { Title: `Ticket ${sale.number}`, Creator: BRAND.name } });
  const chunks: Buffer[] = [];
  d.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { d.on('end', () => resolve(Buffer.concat(chunks))); d.on('error', reject); });
  const w = W - 8 * mm, x = 4 * mm;
  d.font('Helvetica-Bold').fontSize(11).text(a.name, x, 5 * mm, { width: w, align: 'center' });
  if (a.address || a.city) d.font('Helvetica').fontSize(7.5).text([a.address, a.city].filter(Boolean).join(', '), { width: w, align: 'center' });
  d.moveDown(0.5).fontSize(8).text(`${sale.register} · ${dt(sale.createdAt)}`, { width: w, align: 'center' });
  d.text(`Ticket ${sale.number}${sale.seller ? ` · ${sale.seller}` : ''}`, { width: w, align: 'center' });
  d.moveDown(0.6);
  const row = (l: string, r: string, bold = false) => { const y = d.y; d.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 8.5).text(l, x, y, { width: w - 22 * mm }); const y2 = d.y; d.text(r, x + w - 22 * mm, y, { width: 22 * mm, align: 'right' }); d.y = Math.max(y2, d.y); };
  for (const l of lines) row(`${l.quantity} × ${l.name}`, euros(l.quantity * l.unitPriceCents));
  d.moveDown(0.3).moveTo(x, d.y).lineTo(x + w, d.y).lineWidth(0.5).stroke().moveDown(0.3);
  row('TOTAL', euros(sale.totalCents), true);
  d.moveDown(0.3);
  for (const p of payments) {
    row(METHOD[p.method] ?? p.method, euros(p.amountCents));
    if (p.method === 'cash' && p.tenderedCents != null && p.tenderedCents > p.amountCents) { row('  Remis', euros(p.tenderedCents)); row('  Rendu', euros(p.tenderedCents - p.amountCents)); }
  }
  if (sale.status === 'voided') d.moveDown(0.5).font('Helvetica-Bold').fontSize(12).text('VENTE ANNULÉE', x, d.y, { width: w, align: 'center' });
  d.moveDown(0.8).font('Helvetica').fontSize(7.5).text('Merci de votre visite !', x, d.y, { width: w, align: 'center' });
  d.end();
  return done;
}
