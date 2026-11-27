import { BRAND } from '@scenorya/shared';
import { doc, dt, footer, GovAssociation, header, title } from '../asso/governance-pdf';

export interface SheetShow { title: string; subtitle: string | null; author: string | null; director: string | null; genre: string | null; durationMin: number | null; intermissionMin: number | null; ageMin: number | null; synopsis: string | null }

const W = 483;
function section(d: PDFKit.PDFDocument, label: string) {
  if (d.y > d.page.height - 140) d.addPage();
  d.moveDown(0.6).fillColor(BRAND.colors.navy).font('Helvetica-Bold').fontSize(12).text(label, 56);
  d.moveTo(56, d.y + 2).lineTo(56 + W, d.y + 2).lineWidth(0.5).strokeColor('#d5dce6').stroke();
  d.moveDown(0.5);
}
function line(d: PDFKit.PDFDocument, left: string, right: string) {
  if (d.y > d.page.height - 80) d.addPage();
  const y = d.y;
  d.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND.colors.navy).text(left, 56, y, { width: 170 });
  const h1 = d.y - y;
  d.font('Helvetica').fontSize(9.5).fillColor('#24364d').text(right || '—', 232, y, { width: W - 176 });
  d.y = Math.max(y + h1, d.y) + 3;
}

/** Fiche spectacle : présentation, distribution, équipe et dates (dossier de diffusion simplifié). */
export async function showSheetPdf(
  a: GovAssociation, s: SheetShow,
  cast: { role: string; names: string[] }[], crew: { job: string; names: string[] }[],
  dates: { startAt: Date; venue: string | null; cancelled: boolean }[],
) {
  const { d, done } = doc(`Fiche spectacle — ${s.title}`);
  header(d, a);
  title(d, s.title, [s.subtitle, s.author && `de ${s.author}`].filter(Boolean).join(' — ') || undefined);
  const facts = [
    s.director && `Mise en scène : ${s.director}`, s.genre,
    s.durationMin && `Durée : ${Math.floor(s.durationMin / 60) ? `${Math.floor(s.durationMin / 60)} h ${String(s.durationMin % 60).padStart(2, '0')}` : `${s.durationMin} min`}${s.intermissionMin ? ` (entracte de ${s.intermissionMin} min)` : ''}`,
    s.ageMin != null && `À partir de ${s.ageMin} ans`,
  ].filter(Boolean).join('  ·  ');
  if (facts) d.font('Helvetica').fontSize(10).fillColor('#4f6077').text(facts, 56, d.y, { width: W, align: 'center' });
  if (s.synopsis) {
    section(d, 'Présentation');
    d.font('Helvetica').fontSize(10).fillColor('#24364d').text(s.synopsis, 56, d.y, { width: W, align: 'justify' });
  }
  if (cast.length) {
    section(d, 'Distribution');
    cast.forEach((c) => line(d, c.role, c.names.join(', ')));
  }
  if (crew.length) {
    section(d, 'Équipe');
    crew.forEach((c) => line(d, c.job, c.names.join(', ')));
  }
  if (dates.length) {
    section(d, 'Représentations');
    dates.forEach((x) => line(d, dt(x.startAt), `${x.venue ?? ''}${x.cancelled ? ' — ANNULÉE' : ''}`));
  }
  footer(d);
  d.end();
  return done;
}
