import { BRAND } from '@scenorya/shared';
import { doc, footer, GovAssociation, header, title } from '../asso/governance-pdf';

export const DEPARTMENTS: Record<string, { label: string; prefix: string; color: string }> = {
  light: { label: 'Lumière', prefix: 'L', color: '#C77A08' },
  sound: { label: 'Son', prefix: 'S', color: '#1266B2' },
  video: { label: 'Vidéo', prefix: 'V', color: '#7539B2' },
  stage: { label: 'Plateau', prefix: 'P', color: '#067647' },
  fly: { label: 'Cintres', prefix: 'C', color: '#526C85' },
  other: { label: 'Autre', prefix: 'X', color: '#4f6077' },
};

function grid(d: PDFKit.PDFDocument, cols: { label: string; width: number }[], rows: { cells: string[]; color?: string }[]) {
  const x0 = 40;
  const total = cols.reduce((n, c) => n + c.width, 0);
  const draw = (cells: string[], head: boolean, color?: string) => {
    const h = Math.max(...cells.map((c, i) => d.font(head ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).heightOfString(c || '', { width: cols[i].width - 8 }))) + 8;
    if (d.y + h > d.page.height - 60) d.addPage();
    const y = d.y;
    if (head) d.rect(x0, y, total, h).fill('#eef2f8');
    if (color) d.rect(x0, y, 3, h).fill(color);
    let x = x0;
    cells.forEach((c, i) => {
      d.fillColor(BRAND.colors.navy).font(head || i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).text(c || '', x + 5, y + 4, { width: cols[i].width - 8 });
      x += cols[i].width;
    });
    d.moveTo(x0, y + h).lineTo(x0 + total, y + h).lineWidth(0.4).strokeColor('#d5dce6').stroke();
    d.y = y + h;
  };
  draw(cols.map((c) => c.label), true);
  rows.forEach((r) => draw(r.cells, false, r.color));
  d.x = x0;
}

export async function cuesheetPdf(a: GovAssociation, sheet: { title: string; show: string | null }, cues: { number: string | null; department: string; label: string; trigger: string | null; page: string | null; durationSec: number | null; notes: string | null }[], filter: string | null) {
  const { d, done } = doc(`Conduite — ${sheet.title}`);
  header(d, a);
  title(d, `Conduite — ${sheet.title}`, [sheet.show, filter ? `Service : ${DEPARTMENTS[filter]?.label ?? filter}` : 'Tous services'].filter(Boolean).join(' · '));
  grid(d, [{ label: 'Top', width: 48 }, { label: 'Service', width: 58 }, { label: 'Effet', width: 140 }, { label: 'Déclenchement', width: 150 }, { label: 'Page', width: 36 }, { label: 'Durée', width: 38 }, { label: 'Notes', width: 45 }],
    cues.map((c) => ({ color: DEPARTMENTS[c.department]?.color, cells: [c.number ?? '', DEPARTMENTS[c.department]?.label ?? c.department, c.label, c.trigger ?? '', c.page ?? '', c.durationSec != null ? `${c.durationSec} s` : '', c.notes ?? ''] })));
  footer(d);
  d.end();
  return done;
}

const hms = (d: Date) => new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Paris' }).format(d);
const KIND: Record<string, string> = { start: 'Début', go: 'GO', back: 'Retour', jump: 'Saut', standby: 'Attention', note: 'Note', end: 'Fin' };

export async function runReportPdf(a: GovAssociation, sheet: { title: string }, run: { mode: string; startedAt: Date; endedAt: Date | null; report: string | null; performance: string | null; by: string | null }, log: { kind: string; cueLabel: string | null; note: string | null; at: Date; user: string | null }[]) {
  const { d, done } = doc(`Rapport — ${sheet.title}`);
  header(d, a);
  const day = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeZone: 'Europe/Paris' }).format(run.startedAt);
  title(d, `${run.mode === 'show' ? 'Rapport de représentation' : 'Rapport de répétition'} — ${sheet.title}`, `${day} · ${hms(run.startedAt)} → ${run.endedAt ? hms(run.endedAt) : 'en cours'}${run.performance ? ` · ${run.performance}` : ''}`);
  if (run.report) {
    d.fillColor(BRAND.colors.navy).font('Helvetica-Bold').fontSize(11).text('Observations', 40);
    d.font('Helvetica').fontSize(9.5).fillColor('#24364d').text(run.report, 40, d.y + 2, { width: 515 });
    d.moveDown(1);
  }
  const gos = log.filter((l) => l.kind === 'go').length;
  d.font('Helvetica').fontSize(9).fillColor('#4f6077').text(`${gos} top(s) envoyé(s) · conduite menée par ${run.by ?? '—'}`, 40);
  d.moveDown(0.6);
  grid(d, [{ label: 'Heure', width: 60 }, { label: 'Action', width: 60 }, { label: 'Top', width: 200 }, { label: 'Note', width: 120 }, { label: 'Par', width: 75 }],
    log.map((l) => ({ cells: [hms(l.at), KIND[l.kind] ?? l.kind, l.cueLabel ?? '', l.note ?? '', l.user ?? ''] })));
  footer(d);
  d.end();
  return done;
}
