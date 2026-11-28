import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '@scenorya/shared';
import { brandingDir } from '../system/settings.service';

export const MEETING_TYPES: Record<string, string> = {
  ag_ordinaire: 'Assemblée générale ordinaire',
  ag_extraordinaire: 'Assemblée générale extraordinaire',
  ca: 'Conseil d’administration',
  bureau: 'Réunion du bureau',
  autre: 'Réunion',
};

export interface GovAssociation { name: string; legalName: string | null; addressLine: string | null; postalCode: string | null; city: string | null; rna: string | null; primaryColor: string }
export interface GovMeeting { type: string; title: string; startAt: Date; location: string | null; agendaItems: { title: string; description?: string | null; vote: boolean }[]; quorumPercent: number | null; minutes: string | null; closedAt: Date | null }
export interface GovAttendee { number: number; firstName: string; lastName: string; status: string; proxyName: string | null }
export interface GovResolution { number: number; title: string; text: string | null; votesFor: number; votesAgainst: number; abstentions: number; result: string }
export interface Signatories { president: string | null; secretary: string | null }

export const dt = (d: Date) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(d).replace(/(\d{2}):(\d{2})$/, '$1 h $2');
const STATUS: Record<string, string> = { convened: 'Convoqué', present: 'Présent', represented: 'Représenté', excused: 'Excusé', absent: 'Absent' };

export function doc(title: string) {
  const d = new PDFDocument({ size: 'A4', margin: 56, bufferPages: true, info: { Title: title, Creator: `${BRAND.name} ${BRAND.edition}` } });
  const chunks: Buffer[] = [];
  d.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    d.on('end', () => resolve(Buffer.concat(chunks)));
    d.on('error', reject);
  });
  return { d, done };
}

export function header(d: PDFKit.PDFDocument, a: GovAssociation) {
  const accent = /^#[0-9a-f]{6}$/i.test(a.primaryColor) ? a.primaryColor : BRAND.colors.blue;
  d.rect(56, 48, 4, 48).fill(accent);
  d.fillColor(BRAND.colors.navy).font('Helvetica-Bold').fontSize(15).text(a.legalName || a.name, 70, 50);
  d.font('Helvetica').fontSize(8.5).fillColor('#4f6077').text([a.addressLine, [a.postalCode, a.city].filter(Boolean).join(' '), a.rna ? `RNA : ${a.rna}` : null].filter(Boolean).join(' — '), 70, d.y + 2);
  d.moveDown(2.5);
}

export function footer(d: PDFKit.PDFDocument) {
  const range = d.bufferedPageRange();
  const logo = join(brandingDir(), 'derived', 'logos', 'scenorya-horizontal-small.png');
  for (let i = range.start; i < range.start + range.count; i++) {
    d.switchToPage(i);
    // Le pied de page est dans la marge basse : sans cela, PDFKit ouvrirait une page blanche.
    const bottom = d.page.margins.bottom;
    d.page.margins.bottom = 0;
    const y = d.page.height - 46;
    if (existsSync(logo)) d.image(logo, 56, y - 4, { height: 16 });
    d.font('Helvetica').fontSize(7.5).fillColor('#8090a4').text(`Page ${i + 1}/${range.count} — Document généré par ${BRAND.name}`, 56, y, { width: d.page.width - 112, align: 'right', lineBreak: false });
    d.page.margins.bottom = bottom;
  }
}

export function title(d: PDFKit.PDFDocument, text: string, sub?: string) {
  d.fillColor(BRAND.colors.navy).font('Helvetica-Bold').fontSize(17).text(text, 56, d.y, { align: 'center', width: d.page.width - 112 });
  if (sub) d.font('Helvetica').fontSize(11).fillColor('#4f6077').text(sub, { align: 'center', width: d.page.width - 112 });
  d.moveDown(1.2);
}

function agendaList(d: PDFKit.PDFDocument, items: GovMeeting['agendaItems']) {
  d.font('Helvetica-Bold').fontSize(12).fillColor(BRAND.colors.navy).text('Ordre du jour', 56);
  d.moveDown(0.4);
  items.forEach((it, i) => {
    d.font('Helvetica-Bold').fontSize(10.5).fillColor(BRAND.colors.text).text(`${i + 1}. ${it.title}${it.vote ? ' (vote)' : ''}`, 66, d.y, { width: d.page.width - 132 });
    if (it.description) d.font('Helvetica').fontSize(9.5).fillColor('#4f6077').text(it.description, 80, d.y, { width: d.page.width - 146 });
    d.moveDown(0.3);
  });
  d.moveDown(0.8);
}

export async function convocationPdf(a: GovAssociation, m: GovMeeting, s: Signatories) {
  const { d, done } = doc(`Convocation — ${m.title}`);
  header(d, a);
  title(d, 'Convocation', `${MEETING_TYPES[m.type] ?? 'Réunion'} — ${m.title}`);
  d.font('Helvetica').fontSize(11).fillColor(BRAND.colors.text).text(
    `Vous êtes convoqué(e) à la réunion qui se tiendra le ${dt(m.startAt)}${m.location ? `, ${m.location}` : ''}.`,
    56, d.y, { width: d.page.width - 112, lineGap: 2 },
  );
  d.moveDown(1);
  agendaList(d, m.agendaItems);
  if (m.quorumPercent) {
    d.font('Helvetica').fontSize(9.5).fillColor('#4f6077').text(`Pour délibérer valablement, ${m.quorumPercent} % des membres convoqués doivent être présents ou représentés.`, 56, d.y, { width: d.page.width - 112 });
    d.moveDown(1);
  }
  d.font('Helvetica').fontSize(11).fillColor(BRAND.colors.text).text(s.president ? `${s.president}, président(e)` : 'Pour le bureau', 300, d.y + 10, { width: 240, align: 'right' });
  // Pouvoir détachable
  // Le pouvoir est placé en bas de page (nouvelle page si l'ordre du jour est long).
  if (d.y > d.page.height - 290) d.addPage();
  const py = d.page.height - 250;
  d.moveTo(56, py).lineTo(d.page.width - 56, py).dash(4, { space: 3 }).strokeColor('#8090a4').stroke().undash();
  d.font('Helvetica-Bold').fontSize(12).fillColor(BRAND.colors.navy).text('Pouvoir (procuration)', 56, py + 12);
  d.font('Helvetica').fontSize(10).fillColor(BRAND.colors.text).text(
    `Je soussigné(e) ……………………………………………………, membre de ${a.name}, donne pouvoir à ……………………………………………………… pour me représenter et voter en mon nom lors de la réunion du ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' }).format(m.startAt)}.\n\nFait à ……………………………, le ……………………………\n\nSignature précédée de la mention « Bon pour pouvoir » :`,
    56, d.y + 6, { width: d.page.width - 112, lineGap: 3 },
  );
  footer(d);
  d.end();
  return done;
}

export async function attendancePdf(a: GovAssociation, m: GovMeeting, people: GovAttendee[]) {
  const { d, done } = doc(`Feuille de présence — ${m.title}`);
  header(d, a);
  title(d, 'Feuille de présence', `${MEETING_TYPES[m.type] ?? 'Réunion'} — ${dt(m.startAt)}`);
  const W = d.page.width - 112;
  const cols = [56, 96, 290, 56 + W - 150];
  const row = (y: number, cells: string[], bold = false) => {
    d.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(BRAND.colors.text);
    d.text(cells[0], cols[0] + 4, y + 9, { width: 36 });
    d.text(cells[1], cols[1] + 4, y + 9, { width: 190 });
    d.text(cells[2], cols[2] + 4, y + 9, { width: cols[3] - cols[2] - 8 });
    d.text(cells[3], cols[3] + 4, y + 9, { width: 146 });
  };
  let y = d.y;
  d.rect(56, y, W, 28).fill('#f0f3f9');
  row(y, ['N°', 'Nom et prénom', 'Pouvoir donné à / reçu de', 'Signature'], true);
  y += 28;
  const proxiesFor = (p: GovAttendee) => people.filter((o) => o.proxyName === `${p.firstName} ${p.lastName}`).map((o) => `${o.firstName} ${o.lastName}`);
  for (const p of people) {
    if (y > d.page.height - 100) {
      d.addPage();
      y = 56;
    }
    const received = proxiesFor(p);
    const note = p.status === 'represented' && p.proxyName ? `Représenté(e) par ${p.proxyName}` : received.length ? `Pouvoir de : ${received.join(', ')}` : p.status === 'excused' ? 'Excusé(e)' : '';
    row(y, [String(p.number), `${p.lastName.toUpperCase()} ${p.firstName}`, note, '']);
    y += 34;
    d.moveTo(56, y).lineTo(56 + W, y).strokeColor('#d5dce8').lineWidth(0.5).stroke();
  }
  d.font('Helvetica').fontSize(9).fillColor('#4f6077').text(`${people.length} membre(s) convoqué(s).`, 56, y + 12);
  footer(d);
  d.end();
  return done;
}

export async function minutesPdf(a: GovAssociation, m: GovMeeting, people: GovAttendee[], res: GovResolution[], s: Signatories) {
  const { d, done } = doc(`Procès-verbal — ${m.title}`);
  header(d, a);
  title(d, 'Procès-verbal', `${MEETING_TYPES[m.type] ?? 'Réunion'} — ${m.title}`);
  const W = d.page.width - 112;
  const present = people.filter((p) => p.status === 'present').length;
  const represented = people.filter((p) => p.status === 'represented').length;
  const total = people.length;
  const ratio = total ? Math.round(((present + represented) / total) * 1000) / 10 : 0;
  d.font('Helvetica').fontSize(10.5).fillColor(BRAND.colors.text).text(
    `Le ${dt(m.startAt)}${m.location ? `, ${m.location}` : ''}, les membres de ${a.name} se sont réunis sur convocation. ` +
      `${present} membre(s) présent(s) et ${represented} représenté(s) sur ${total} convoqué(s), soit ${ratio.toString().replace('.', ',')} %. ` +
      (m.quorumPercent ? (ratio >= m.quorumPercent ? `Le quorum de ${m.quorumPercent} % étant atteint, la réunion peut valablement délibérer.` : `Le quorum de ${m.quorumPercent} % n’est pas atteint.`) : ''),
    56, d.y, { width: W, lineGap: 2 },
  );
  d.moveDown(1);
  agendaList(d, m.agendaItems);
  if (res.length) {
    d.font('Helvetica-Bold').fontSize(12).fillColor(BRAND.colors.navy).text('Délibérations', 56);
    d.moveDown(0.4);
    for (const r of res) {
      d.font('Helvetica-Bold').fontSize(10.5).fillColor(BRAND.colors.text).text(`Résolution n° ${r.number} — ${r.title}`, 56, d.y, { width: W });
      if (r.text) d.font('Helvetica').fontSize(10).text(r.text, 56, d.y, { width: W });
      d.font('Helvetica').fontSize(10).fillColor('#4f6077').text(`Pour : ${r.votesFor} — Contre : ${r.votesAgainst} — Abstentions : ${r.abstentions}. `, 56, d.y, { continued: true, width: W });
      d.font('Helvetica-Bold').fillColor(r.result === 'adopted' ? '#18753c' : '#c0262d').text(r.result === 'adopted' ? 'Résolution adoptée.' : r.result === 'rejected' ? 'Résolution rejetée.' : 'Non votée.');
      d.moveDown(0.6);
    }
    d.moveDown(0.6);
  }
  if (m.minutes) {
    d.font('Helvetica-Bold').fontSize(12).fillColor(BRAND.colors.navy).text('Compte rendu des débats', 56);
    d.moveDown(0.4);
    d.font('Helvetica').fontSize(10.5).fillColor(BRAND.colors.text).text(m.minutes, 56, d.y, { width: W, lineGap: 2 });
    d.moveDown(1);
  }
  d.font('Helvetica').fontSize(10).fillColor(BRAND.colors.text).text('L’ordre du jour étant épuisé, la séance est levée.', 56, d.y, { width: W });
  if (d.y > d.page.height - 160) d.addPage();
  const sy = d.y + 24;
  d.font('Helvetica-Bold').fontSize(10).text('Le/La président(e) de séance', 56, sy, { width: 220 });
  d.font('Helvetica').text(s.president ?? '', 56, sy + 14, { width: 220 });
  d.font('Helvetica-Bold').text('Le/La secrétaire de séance', 320, sy, { width: 220 });
  d.font('Helvetica').text(s.secretary ?? '', 320, sy + 14, { width: 220 });
  if (m.closedAt) d.font('Helvetica').fontSize(8).fillColor('#8090a4').text(`Procès-verbal clôturé le ${dt(m.closedAt)} dans Scenorya : contenu figé.`, 56, sy + 80, { width: W });
  footer(d);
  d.end();
  return done;
}
