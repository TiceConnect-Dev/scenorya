import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { BRAND } from '@scenorya/shared';
import type { DbOrTx } from '../db/db';
import { counters, showPerformances, shows, showVenues, ticketEvents, ticketOrders, ticketRates, tickets } from '../db/schema';
import { BadRequest, Conflict } from '../common/errors';
import { randomToken } from '../common/crypto';
import { loadConfig } from '../config';
import { brandingDir, emailLayout, SettingsService } from '../system/settings.service';

export type TicketEvent = typeof ticketEvents.$inferSelect;
export const PAYMENT: Record<string, string> = { cash: 'Espèces', card: 'Carte bancaire', cheque: 'Chèque', transfer: 'Virement', free: 'Gratuit', other: 'Autre' };
const base = () => loadConfig().PUBLIC_URL.replace(/\/$/, '');
export const ticketUrl = (code: string) => `${base()}/billet/${code}`;
export const orderUrl = (token: string) => `${base()}/billets/${token}`;
/** Extrait le code d'un QR (adresse /billet/<code>) ou d'une saisie manuelle. */
export const codeOf = (raw: string) => (raw.trim().match(/([A-Za-z0-9_-]{16,64})\/?$/)?.[1] ?? '');
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
export const money = (c: number) => (c === 0 ? 'Gratuit' : `${(c / 100).toFixed(2).replace('.', ',')} €`);
export const when = (d: Date) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(d).replace(/(\d{2}):(\d{2})$/, '$1 h $2');

/**
 * Séance avec ses valeurs effectives : une représentation de Show rattachée
 * impose sa date et son lieu (une modification dans Show se répercute).
 */
export async function effectiveEvents(db: DbOrTx, where: ReturnType<typeof and>) {
  const rows = await db.select({
    e: ticketEvents, perfStart: showPerformances.startAt, perfStatus: showPerformances.status, perfDoors: showPerformances.doorsAt,
    venueName: showVenues.name, venueCity: showVenues.city, showTitle: shows.title, showId: shows.id,
  }).from(ticketEvents)
    .leftJoin(showPerformances, eq(showPerformances.id, ticketEvents.performanceId))
    .leftJoin(shows, eq(shows.id, showPerformances.showId))
    .leftJoin(showVenues, eq(showVenues.id, showPerformances.venueId))
    .where(where).orderBy(asc(sql`coalesce(${showPerformances.startAt}, ${ticketEvents.startAt})`));
  return rows.map((r) => ({
    ...r.e,
    startAt: r.perfStart ?? r.e.startAt,
    venue: r.venueName ? [r.venueName, r.venueCity].filter(Boolean).join(', ') : r.e.venue,
    doorsAt: r.perfDoors ?? null,
    show: r.showId ? { id: r.showId, title: r.showTitle!, performanceStatus: r.perfStatus } : null,
  }));
}
export type EffectiveEvent = Awaited<ReturnType<typeof effectiveEvents>>[number];

/** Billets valides par séance et par tarif. */
export async function counts(db: DbOrTx, eventIds: string[]) {
  if (!eventIds.length) return { byEvent: new Map<string, number>(), byRate: new Map<string, number>(), scanned: new Map<string, number>() };
  const rows = await db.select({ eventId: tickets.eventId, rateId: tickets.rateId, n: sql<number>`count(*)::int`, s: sql<number>`count(${tickets.scannedAt})::int` })
    .from(tickets).where(and(inArray(tickets.eventId, eventIds), eq(tickets.status, 'valid'))).groupBy(tickets.eventId, tickets.rateId);
  const byEvent = new Map<string, number>(), byRate = new Map<string, number>(), scanned = new Map<string, number>();
  for (const r of rows) {
    byEvent.set(r.eventId, (byEvent.get(r.eventId) ?? 0) + r.n);
    scanned.set(r.eventId, (scanned.get(r.eventId) ?? 0) + r.s);
    if (r.rateId) byRate.set(r.rateId, r.n);
  }
  return { byEvent, byRate, scanned };
}

async function nextNumber(tx: DbOrTx, associationId: string, year: number) {
  const key = `ticket-order-${year}`;
  const [row] = await tx.insert(counters).values({ associationId, key, value: 1 })
    .onConflictDoUpdate({ target: [counters.associationId, counters.key], set: { value: sql`${counters.value} + 1` } }).returning({ value: counters.value });
  return `B${year}-${String(row.value).padStart(5, '0')}`;
}

export interface IssueInput {
  associationId: string; event: TicketEvent; lines: { rateId: string; quantity: number; holderNames?: string[] }[];
  buyerName: string; buyerEmail?: string | null; buyerPhone?: string | null; notes?: string | null;
  status: 'pending' | 'paid'; channel: 'box_office' | 'online' | 'invitation'; paymentMethod?: string | null;
  createdBy?: string | null; ipHash?: string | null; publicOnly?: boolean;
}

/**
 * Émet une commande et ses billets sous verrou par séance :
 * jauge, quotas par tarif et limite par commande vérifiés de façon atomique.
 */
export async function issueOrder(tx: DbOrTx, input: IssueInput) {
  const ev = input.event;
  if (ev.status === 'cancelled') throw BadRequest('EVENT_CANCELLED', 'Cette séance est annulée.');
  const lines = input.lines.filter((l) => l.quantity > 0);
  if (!lines.length) throw BadRequest('EMPTY_ORDER', 'Choisissez au moins un billet.');
  const ids = [...new Set(lines.map((l) => l.rateId))];
  if (ids.length !== lines.length) throw BadRequest('DUPLICATE_RATE', 'Un tarif figure deux fois.');
  const total = lines.reduce((n, l) => n + l.quantity, 0);
  if (input.publicOnly && total > ev.maxPerOrder) throw BadRequest('TOO_MANY_TICKETS', `${ev.maxPerOrder} billet(s) au maximum par commande.`);
  if (total > 500) throw BadRequest('TOO_MANY_TICKETS', '500 billets au maximum par commande.');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tickets:${ev.id}`}))`);
  const rates = await tx.select().from(ticketRates).where(and(eq(ticketRates.eventId, ev.id), inArray(ticketRates.id, ids)));
  if (rates.length !== ids.length) throw BadRequest('UNKNOWN_RATE', 'Tarif inconnu pour cette séance.');
  if (input.publicOnly && rates.some((r) => !r.publicVisible)) throw BadRequest('UNKNOWN_RATE', 'Tarif non proposé en ligne.');
  const c = await counts(tx, [ev.id]);
  const sold = c.byEvent.get(ev.id) ?? 0;
  if (ev.capacity != null && sold + total > ev.capacity) throw Conflict('SOLD_OUT', ev.capacity - sold > 0 ? `Il ne reste que ${ev.capacity - sold} place(s).` : 'Complet.', { remaining: Math.max(0, ev.capacity - sold) });
  for (const l of lines) {
    const r = rates.find((x) => x.id === l.rateId)!;
    const taken = c.byRate.get(r.id) ?? 0;
    if (r.quota != null && taken + l.quantity > r.quota) throw Conflict('RATE_SOLD_OUT', `Tarif « ${r.name} » : ${Math.max(0, r.quota - taken)} place(s) restante(s).`, { rateId: r.id });
  }
  const totalCents = lines.reduce((n, l) => n + l.quantity * rates.find((x) => x.id === l.rateId)!.priceCents, 0);
  const free = totalCents === 0;
  const status = free ? 'paid' : input.status;
  const now = new Date();
  const [order] = await tx.insert(ticketOrders).values({
    associationId: input.associationId, eventId: ev.id, number: await nextNumber(tx, input.associationId, now.getFullYear()),
    buyerName: input.buyerName, buyerEmail: input.buyerEmail ?? null, buyerPhone: input.buyerPhone ?? null, notes: input.notes ?? null,
    status, channel: input.channel, paymentMethod: free ? 'free' : status === 'paid' ? (input.paymentMethod ?? 'other') : null,
    totalCents, paidAt: status === 'paid' ? now : null, publicToken: randomToken(24), ipHash: input.ipHash ?? null, createdBy: input.createdBy ?? null,
  }).returning();
  const values = lines.flatMap((l) => {
    const r = rates.find((x) => x.id === l.rateId)!;
    return Array.from({ length: l.quantity }, (_, i) => ({ orderId: order.id, eventId: ev.id, rateId: r.id, rateName: r.name, priceCents: r.priceCents, code: randomToken(16), holderName: l.holderNames?.[i]?.trim() || null }));
  });
  const issued = await tx.insert(tickets).values(values).returning();
  return { order, tickets: issued };
}

/** PDF des billets : trois par page A4, QR code, séance, tarif, porteur. */
export async function ticketsPdf(association: { name: string; primaryColor: string }, ev: EffectiveEvent, order: { number: string; buyerName: string; status: string }, list: { code: string; rateName: string; priceCents: number; holderName: string | null; status: string }[]) {
  const d = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Billets ${order.number}`, Creator: BRAND.name } });
  const chunks: Buffer[] = [];
  d.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { d.on('end', () => resolve(Buffer.concat(chunks))); d.on('error', reject); });
  const accent = /^#[0-9a-f]{6}$/i.test(association.primaryColor) ? association.primaryColor : BRAND.colors.blue;
  const mm = 72 / 25.4, W = 210 * mm, H = 99 * mm;
  for (let i = 0; i < list.length; i++) {
    if (i > 0 && i % 3 === 0) d.addPage();
    const t = list[i], y = (i % 3) * H;
    d.rect(10 * mm, y + 8 * mm, W - 20 * mm, H - 16 * mm).lineWidth(0.8).dash(3, { space: 3 }).strokeColor('#9aa8bb').stroke().undash();
    d.rect(10 * mm, y + 8 * mm, 4 * mm, H - 16 * mm).fill(accent);
    const x = 20 * mm, w = 120 * mm;
    d.fillColor('#4f6077').font('Helvetica').fontSize(9).text(association.name, x, y + 14 * mm, { width: w });
    d.fillColor(BRAND.colors.navy).font('Helvetica-Bold').fontSize(17).text(ev.title, x, y + 20 * mm, { width: w, height: 22 * mm, ellipsis: true });
    d.font('Helvetica').fontSize(10.5).fillColor('#1d2b3f').text(when(ev.startAt), x, y + 44 * mm, { width: w });
    if (ev.venue) d.text(ev.venue, x, d.y + 2, { width: w });
    d.font('Helvetica-Bold').fontSize(11).text(`${t.rateName} — ${money(t.priceCents)}`, x, y + 62 * mm, { width: w });
    d.font('Helvetica').fontSize(9).fillColor('#4f6077').text([t.holderName ?? order.buyerName, `Commande ${order.number}`].join(' · '), x, d.y + 3, { width: w });
    if (t.status !== 'valid') d.font('Helvetica-Bold').fontSize(14).fillColor('#C63D41').text('BILLET ANNULÉ', x, y + 76 * mm);
    else if (order.status === 'pending') d.font('Helvetica-Bold').fontSize(9).fillColor('#C77A08').text('À régler à l’accueil', x, y + 76 * mm);
    const qr = await QRCode.toBuffer(ticketUrl(t.code), { errorCorrectionLevel: 'M', margin: 0, width: 300 });
    d.image(qr, W - 62 * mm, y + 18 * mm, { width: 46 * mm });
    d.font('Courier').fontSize(7).fillColor('#4f6077').text(t.code, W - 66 * mm, y + 67 * mm, { width: 54 * mm, align: 'center' });
    d.font('Helvetica').fontSize(7).text('Billet nominatif à présenter à l’entrée. Un seul passage par code.', W - 66 * mm, y + 73 * mm, { width: 54 * mm, align: 'center' });
  }
  d.end();
  return done;
}

/** Envoi des billets par e-mail (si la messagerie est configurée) ; renvoie l'état de l'envoi. */
export async function mailTickets(settings: SettingsService, association: { name: string; primaryColor: string }, ev: EffectiveEvent, order: typeof ticketOrders.$inferSelect, list: (typeof tickets.$inferSelect)[]) {
  if (!order.buyerEmail) return 'no_email';
  try {
    const { transporter, from } = await settings.transport();
    const url = orderUrl(order.publicToken);
    const pdf = await ticketsPdf(association, ev, order, list);
    const logo = join(brandingDir(), 'derived', 'logos', 'scenorya-horizontal-small.png');
    const pending = order.status === 'pending' ? `Montant à régler à l’accueil : ${money(order.totalCents)}.` : '';
    await transporter.sendMail({
      from, to: order.buyerEmail, subject: `${association.name} — Vos billets : ${ev.title}`,
      text: `Bonjour ${order.buyerName},\n\nVoici vos ${list.length} billet(s) pour « ${ev.title} », ${when(ev.startAt)}${ev.venue ? `, ${ev.venue}` : ''}.\n${pending}\n\nVos billets (à présenter à l’entrée, sur téléphone ou imprimés) : ${url}\n\nCommande ${order.number}.`,
      html: emailLayout('Vos billets', `<p>Bonjour ${esc(order.buyerName)},</p><p>Voici vos ${list.length} billet(s) pour <strong>${esc(ev.title)}</strong>, ${esc(when(ev.startAt))}${ev.venue ? `, ${esc(ev.venue)}` : ''}.</p>${pending ? `<p><strong>${esc(pending)}</strong></p>` : ''}<p><a href="${url}">Afficher mes billets</a> — à présenter à l’entrée, sur téléphone ou imprimés (PDF joint).</p><p>Commande ${esc(order.number)}.</p>`),
      attachments: [{ filename: `billets-${order.number}.pdf`, content: pdf }, ...(existsSync(logo) ? [{ filename: 'scenorya.png', path: logo, cid: 'scenorya-logo' }] : [])],
    });
    return 'sent';
  } catch (e) {
    return `failed: ${(e as Error).message.slice(0, 120)}`;
  }
}
