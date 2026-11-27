import { BRAND } from '@scenorya/shared';
import { doc, dt, footer, GovAssociation, header, title } from '../asso/governance-pdf';

export interface PdfRole { name: string; category: string; leads: string[]; understudies: string[] }
export interface PdfScene { label: string; roles: string[] }
export interface PdfCall { name: string; roles: string[]; understudy: boolean; unavailable: string | null; phone: string | null }

const CATEGORY: Record<string, string> = { main: 'Principal', secondary: 'Secondaire', ensemble: 'Ensemble' };

function table(d: PDFKit.PDFDocument, cols: { label: string; width: number }[], rows: string[][]) {
  const x0 = 56;
  const line = (cells: string[], bold: boolean) => {
    const h = Math.max(...cells.map((c, i) => d.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).heightOfString(c || '—', { width: cols[i].width - 8 }))) + 8;
    if (d.y + h > d.page.height - 70) d.addPage();
    const y = d.y;
    if (bold) d.rect(x0, y, cols.reduce((n, c) => n + c.width, 0), h).fill('#eef2f8');
    let x = x0;
    cells.forEach((c, i) => {
      d.fillColor(BRAND.colors.navy).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).text(c || '—', x + 4, y + 4, { width: cols[i].width - 8 });
      x += cols[i].width;
    });
    d.moveTo(x0, y + h).lineTo(x, y + h).lineWidth(0.5).strokeColor('#d5dce6').stroke();
    d.y = y + h;
  };
  line(cols.map((c) => c.label), true);
  rows.forEach((r) => line(r, false));
  d.x = x0;
  d.moveDown(1);
}

/** Distribution : rôles, titulaires, doublures, puis présence des personnages par scène. */
export async function distributionPdf(a: GovAssociation, p: { title: string; author: string | null; season: string | null }, roles: PdfRole[], scenes: PdfScene[]) {
  const { d, done } = doc(`Distribution — ${p.title}`);
  header(d, a);
  title(d, `Distribution — ${p.title}`, [p.author, p.season].filter(Boolean).join(' · ') || undefined);
  table(d, [{ label: 'Rôle', width: 150 }, { label: 'Catégorie', width: 75 }, { label: 'Titulaire(s)', width: 130 }, { label: 'Doublure(s)', width: 128 }],
    roles.map((r) => [r.name, CATEGORY[r.category] ?? r.category, r.leads.join(', '), r.understudies.join(', ')]));
  if (scenes.length) {
    d.fillColor(BRAND.colors.navy).font('Helvetica-Bold').fontSize(12).text('Présence par scène', 56);
    d.moveDown(0.4);
    table(d, [{ label: 'Scène', width: 170 }, { label: 'Personnages présents', width: 313 }], scenes.map((s) => [s.label, s.roles.join(', ')]));
  }
  footer(d);
  d.end();
  return done;
}

/** Feuille de service d'une répétition : convoqués, rôles, indisponibilités signalées. */
export async function callSheetPdf(
  a: GovAssociation, p: { title: string },
  r: { title: string | null; startAt: Date; endAt: Date; location: string | null; notes: string | null },
  scenes: string[], calls: PdfCall[],
) {
  const { d, done } = doc(`Feuille de service — ${p.title}`);
  header(d, a);
  title(d, r.title || `Répétition — ${p.title}`, `${dt(r.startAt)}, jusqu’à ${dt(r.endAt).split(' à ').pop()}${r.location ? ` — ${r.location}` : ''}`);
  d.fillColor(BRAND.colors.navy).font('Helvetica-Bold').fontSize(11).text('Travail prévu', 56);
  d.font('Helvetica').fontSize(10).text(scenes.length ? scenes.join(' ; ') : 'Filage : toute la pièce.', { width: d.page.width - 112 });
  if (r.notes) {
    d.moveDown(0.4).font('Helvetica-Oblique').fontSize(9.5).fillColor('#4f6077').text(r.notes, { width: d.page.width - 112 });
  }
  d.moveDown(1);
  table(d, [{ label: 'Convoqué(e)', width: 140 }, { label: 'Rôle(s)', width: 150 }, { label: 'Téléphone', width: 85 }, { label: 'Remarque', width: 108 }],
    calls.map((c) => [c.name, `${c.roles.join(', ')}${c.understudy ? ' (doublure)' : ''}`, c.phone ?? '', c.unavailable ? `Indisponible : ${c.unavailable}` : '']));
  footer(d);
  d.end();
  return done;
}
