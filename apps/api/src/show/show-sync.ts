import { and, eq, gt, inArray, ne } from 'drizzle-orm';
import { isFeatureEnabled, ResolvedModules } from '@scenorya/shared';
import type { DbOrTx } from '../db/db';
import { castAssignments, castProductions, castRoles, eventParticipants, events, members, showCrew, showPerformances, shows, showVenues } from '../db/schema';

type Performance = typeof showPerformances.$inferSelect;

/** Personnes convoquées à une représentation : équipe du spectacle et titulaires confirmés des distributions rattachées. */
export async function performanceCall(db: DbOrTx, showId: string, modules: ResolvedModules) {
  const crew = await db.select({ id: showCrew.memberId }).from(showCrew).innerJoin(members, eq(members.id, showCrew.memberId)).where(and(eq(showCrew.showId, showId), ne(members.status, 'archived')));
  const ids = new Set(crew.map((r) => r.id));
  if (modules.cast?.usable && isFeatureEnabled(modules, 'cast.distributions')) {
    const cast = await db.select({ id: castAssignments.memberId }).from(castAssignments).innerJoin(castRoles, eq(castRoles.id, castAssignments.roleId))
      .innerJoin(castProductions, eq(castProductions.id, castRoles.productionId)).innerJoin(members, eq(members.id, castAssignments.memberId))
      .where(and(eq(castProductions.showId, showId), eq(castAssignments.kind, 'lead'), eq(castAssignments.status, 'confirmed'), ne(members.status, 'archived')));
    for (const r of cast) ids.add(r.id);
  }
  return [...ids];
}

/** Événement d'agenda d'une représentation (fonctionnalité show.agenda) ; réponses déjà données conservées. */
export async function syncPerformanceEvent(tx: DbOrTx, ctx: { associationId: string; userId: string; modules: ResolvedModules }, perf: Performance) {
  if (!isFeatureEnabled(ctx.modules, 'show.agenda')) return perf.eventId;
  const [s] = await tx.select().from(shows).where(eq(shows.id, perf.showId));
  const [v] = perf.venueId ? await tx.select().from(showVenues).where(eq(showVenues.id, perf.venueId)) : [];
  const values = {
    title: `Représentation — ${s.title}`, category: 'performance', startAt: perf.startAt, endAt: perf.endAt,
    location: v ? [v.name, v.city].filter(Boolean).join(', ') : null,
    description: [perf.doorsAt ? `Accueil du public : ${new Intl.DateTimeFormat('fr-FR', { timeStyle: 'short', timeZone: 'Europe/Paris' }).format(perf.doorsAt)}` : null, perf.notes].filter(Boolean).join('\n') || null,
    visibility: s.status === 'draft' ? 'internal' : 'public',
    cancelledAt: perf.status === 'cancelled' ? new Date() : null,
    updatedAt: new Date(),
  };
  let eventId = perf.eventId;
  if (eventId) {
    const [still] = await tx.update(events).set(values).where(eq(events.id, eventId)).returning({ id: events.id });
    if (!still) eventId = null;
  }
  if (!eventId) {
    const [e] = await tx.insert(events).values({ ...values, associationId: ctx.associationId, createdBy: ctx.userId }).returning({ id: events.id });
    eventId = e.id;
    await tx.update(showPerformances).set({ eventId }).where(eq(showPerformances.id, perf.id));
  }
  const wanted = await performanceCall(tx, perf.showId, ctx.modules);
  const current = (await tx.select({ m: eventParticipants.memberId }).from(eventParticipants).where(eq(eventParticipants.eventId, eventId))).map((x) => x.m);
  const gone = current.filter((m) => !wanted.includes(m));
  const fresh = wanted.filter((m) => !current.includes(m));
  if (gone.length) await tx.delete(eventParticipants).where(and(eq(eventParticipants.eventId, eventId), inArray(eventParticipants.memberId, gone)));
  if (fresh.length) await tx.insert(eventParticipants).values(fresh.map((memberId) => ({ eventId: eventId!, memberId }))).onConflictDoNothing();
  return eventId;
}

/** Après un changement d'équipe ou de distribution : mise à jour des représentations à venir. */
export async function resyncShow(db: DbOrTx, ctx: { associationId: string; userId: string; modules: ResolvedModules }, showId: string) {
  if (!isFeatureEnabled(ctx.modules, 'show.agenda')) return;
  const list = await db.select().from(showPerformances).where(and(eq(showPerformances.showId, showId), gt(showPerformances.startAt, new Date()), ne(showPerformances.status, 'cancelled')));
  for (const p of list) await syncPerformanceEvent(db, ctx, p);
}
