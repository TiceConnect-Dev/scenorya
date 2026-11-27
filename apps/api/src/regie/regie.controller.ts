import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, OnModuleInit, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { grantsCover, isFeatureEnabled } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { parse, patchOf, zOptText, zUuid } from '../common/validation';
import { AppError, BadRequest, Conflict, NotFound } from '../common/errors';
import { DB, Db, DbOrTx } from '../db/db';
import { associations, driveFiles, driveLinks, regieCues, regieCuesheets, regieRunLog, regieRuns, regieSounds, showPerformances, shows, users } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ModuleImpact, ModulesService } from '../modules/modules.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { blobExists, blobPath, fileHeaders } from '../drive/storage';
import { cuesheetPdf, DEPARTMENTS, runReportPdf } from './regie-pdf';

const log = (c: AssocCtx) => ({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, ip: c.ip });
const zDept = z.enum(['light', 'sound', 'video', 'stage', 'fly', 'other']);
const zCue = z.object({
  number: zOptText(20), department: zDept.default('light'), label: z.string().trim().min(1).max(200),
  trigger: zOptText(500), page: zOptText(20), durationSec: z.number().int().min(0).max(36_000).nullable().optional(),
  notes: zOptText(1000), soundId: zUuid.nullable().optional(),
});
const zSound = z.object({
  driveFileId: zUuid, label: z.string().trim().min(1).max(120), hotkey: z.string().regex(/^[1-9A-Z]$/, 'Touche 1 à 9 ou A à Z').nullable().optional(),
  volume: z.number().int().min(0).max(100).default(100), loop: z.boolean().default(false),
  fadeInMs: z.number().int().min(0).max(60_000).default(0), fadeOutMs: z.number().int().min(0).max(60_000).default(0),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});
const zAction = z.object({
  kind: z.enum(['go', 'back', 'jump', 'standby', 'note']),
  cueId: zUuid.nullable().optional(),
  note: zOptText(500),
  /** Heure de l'action sur le poste (actions rejouées après une coupure réseau). */
  at: z.coerce.date().optional(),
});

type Sheet = typeof regieCuesheets.$inferSelect;
type Run = typeof regieRuns.$inferSelect;

@ApiTags('Scenorya Régie')
@Controller()
export class RegieController implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly modules: ModulesService, private readonly rt: RealtimeGateway) {}

  onModuleInit() {
    this.modules.registerImpactProvider({
      module: 'regie',
      check: async (db, associationId) => {
        const out: ModuleImpact[] = [];
        const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(regieRuns).innerJoin(regieCuesheets, eq(regieCuesheets.id, regieRuns.cuesheetId))
          .where(and(eq(regieCuesheets.associationId, associationId), isNull(regieRuns.endedAt)));
        if (r.n > 0) out.push({ module: 'regie', level: 'warning', message: `${r.n} séance(s) de conduite en cours seront interrompues.` });
        const [s] = await db.select({ n: sql<number>`count(*)::int` }).from(regieCuesheets).where(eq(regieCuesheets.associationId, associationId));
        if (s.n > 0) out.push({ module: 'regie', level: 'info', message: `${s.n} conduite(s) conservée(s).` });
        return out;
      },
    });
  }

  /* ============================================================ Accès */

  private async sheet(associationId: string, id: string) {
    parse(zUuid, id);
    const [s] = await this.db.select().from(regieCuesheets).where(and(eq(regieCuesheets.id, id), eq(regieCuesheets.associationId, associationId)));
    if (!s) throw NotFound('Conduite introuvable.');
    return s;
  }

  /** Édition interdite si la conduite est figée ou si une représentation est en cours. */
  private async editable(associationId: string, id: string, tx: DbOrTx = this.db) {
    const s = await this.sheet(associationId, id);
    if (s.locked) throw new AppError(HttpStatus.LOCKED, 'CUESHEET_LOCKED', 'Conduite figée : déverrouillez-la pour la modifier.');
    const [live] = await tx.select({ id: regieRuns.id }).from(regieRuns).where(and(eq(regieRuns.cuesheetId, id), isNull(regieRuns.endedAt), eq(regieRuns.mode, 'show')));
    if (live) throw new AppError(HttpStatus.LOCKED, 'SHOW_RUNNING', 'Représentation en cours : la conduite ne peut pas être modifiée.');
    return s;
  }

  private async cueOf(associationId: string, id: string) {
    parse(zUuid, id);
    const [r] = await this.db.select({ q: regieCues, s: regieCuesheets }).from(regieCues).innerJoin(regieCuesheets, eq(regieCuesheets.id, regieCues.cuesheetId))
      .where(and(eq(regieCues.id, id), eq(regieCuesheets.associationId, associationId)));
    if (!r) throw NotFound('Top introuvable.');
    return r;
  }

  private async soundOf(associationId: string, id: string) {
    parse(zUuid, id);
    const [r] = await this.db.select({ so: regieSounds, s: regieCuesheets }).from(regieSounds).innerJoin(regieCuesheets, eq(regieCuesheets.id, regieSounds.cuesheetId))
      .where(and(eq(regieSounds.id, id), eq(regieCuesheets.associationId, associationId)));
    if (!r) throw NotFound('Son introuvable.');
    return r;
  }

  private async runOf(associationId: string, id: string) {
    parse(zUuid, id);
    const [r] = await this.db.select({ r: regieRuns, s: regieCuesheets }).from(regieRuns).innerJoin(regieCuesheets, eq(regieCuesheets.id, regieRuns.cuesheetId))
      .where(and(eq(regieRuns.id, id), eq(regieCuesheets.associationId, associationId)));
    if (!r) throw NotFound('Séance introuvable.');
    return r;
  }

  private async assertShow(c: AssocCtx, showId: string | null | undefined) {
    if (!showId) return;
    if (!c.modules.show?.usable || !isFeatureEnabled(c.modules, 'regie.showLink')) throw BadRequest('FEATURE_DISABLED', 'Activez Scenorya Show pour rattacher la conduite à un spectacle.');
    const [s] = await this.db.select({ id: shows.id }).from(shows).where(and(eq(shows.id, showId), eq(shows.associationId, c.association.id)));
    if (!s) throw NotFound('Spectacle introuvable.');
  }

  private async cues(sheetId: string, tx: DbOrTx = this.db) {
    return tx.select().from(regieCues).where(eq(regieCues.cuesheetId, sheetId)).orderBy(asc(regieCues.position), asc(regieCues.createdAt));
  }

  private changed(sheetId: string) {
    this.rt.emitRegie(sheetId, 'regie:sheet', { cuesheetId: sheetId });
  }

  /* ============================================================ Conduites */

  @Access('regie', 'regie.cuesheets.read')
  @Get('regie/cuesheets')
  async list(@AssocContext() c: AssocCtx) {
    const rows = await this.db.select({ s: regieCuesheets, show: shows.title }).from(regieCuesheets).leftJoin(shows, eq(shows.id, regieCuesheets.showId))
      .where(eq(regieCuesheets.associationId, c.association.id)).orderBy(desc(regieCuesheets.updatedAt));
    if (!rows.length) return [];
    const stats = await this.db.execute<{ id: string; cues: number; live: boolean; last: string | null }>(sql`
      select s.id, (select count(*)::int from regie_cues q where q.cuesheet_id = s.id) as cues,
        exists (select 1 from regie_runs r where r.cuesheet_id = s.id and r.ended_at is null) as live,
        (select max(started_at) from regie_runs r where r.cuesheet_id = s.id) as last
      from regie_cuesheets s where s.id in ${rows.map((r) => r.s.id)}`);
    const st = new Map(stats.rows.map((r) => [r.id, r]));
    return rows.map(({ s, show }) => ({ ...s, show, cues: st.get(s.id)?.cues ?? 0, live: st.get(s.id)?.live ?? false, lastRun: st.get(s.id)?.last ?? null }));
  }

  @Access('regie', 'regie.cuesheets.create')
  @Post('regie/cuesheets')
  async create(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(z.object({ title: z.string().trim().min(1).max(200), showId: zUuid.nullable().optional(), notes: zOptText(4000) }), body);
    await this.assertShow(c, input.showId);
    const [s] = await this.db.insert(regieCuesheets).values({ ...input, showId: input.showId ?? null, associationId: c.association.id, createdBy: c.user.id }).returning();
    await this.audit.log({ ...log(c), action: 'regie.cuesheet.create', resourceType: 'regie_cuesheet', resourceId: s.id, summary: `Création de la conduite « ${s.title} »` });
    return s;
  }

  @Access('regie', 'regie.cuesheets.read')
  @Get('regie/cuesheets/:id')
  async detail(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const s = await this.sheet(c.association.id, id);
    const [show] = s.showId ? await this.db.select({ id: shows.id, title: shows.title }).from(shows).where(eq(shows.id, s.showId)) : [];
    const sounds = await this.db.select({ so: regieSounds, name: driveFiles.name, mime: driveFiles.mime, deleted: driveFiles.deletedAt }).from(regieSounds)
      .leftJoin(driveFiles, eq(driveFiles.id, regieSounds.driveFileId)).where(eq(regieSounds.cuesheetId, id)).orderBy(asc(regieSounds.position), asc(regieSounds.createdAt));
    const [run] = await this.db.select().from(regieRuns).where(and(eq(regieRuns.cuesheetId, id), isNull(regieRuns.endedAt))).limit(1);
    const performances = show && c.modules.show?.usable
      ? await this.db.select({ id: showPerformances.id, startAt: showPerformances.startAt, status: showPerformances.status }).from(showPerformances)
        .where(eq(showPerformances.showId, show.id)).orderBy(asc(showPerformances.startAt))
      : [];
    return {
      ...s, show: show ?? null, cues: await this.cues(id),
      sounds: sounds.map(({ so, name, mime, deleted }) => ({ ...so, fileName: name, mime, available: !!name && !deleted })),
      activeRun: run ?? null, performances,
      features: { cart: isFeatureEnabled(c.modules, 'regie.cart'), showLink: isFeatureEnabled(c.modules, 'regie.showLink') && !!c.modules.show?.usable },
      can: { operate: grantsCover(c.grants, 'regie.runs.operate'), edit: grantsCover(c.grants, 'regie.cuesheets.update') },
    };
  }

  @Access('regie', 'regie.cuesheets.update')
  @Patch('regie/cuesheets/:id')
  async update(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const before = await this.sheet(c.association.id, id);
    const input = parse(z.object({ title: z.string().trim().min(1).max(200).optional(), showId: zUuid.nullable().optional(), notes: zOptText(4000), locked: z.boolean().optional() }), body);
    if (input.showId !== undefined) await this.assertShow(c, input.showId);
    // Seul le verrou peut changer sur une conduite figée.
    if (before.locked && (input.title !== undefined || input.showId !== undefined || input.notes !== undefined) && input.locked !== false) {
      throw new AppError(HttpStatus.LOCKED, 'CUESHEET_LOCKED', 'Conduite figée : déverrouillez-la pour la modifier.');
    }
    const [s] = await this.db.update(regieCuesheets).set({ ...input, updatedAt: new Date() }).where(eq(regieCuesheets.id, id)).returning();
    const what = input.locked === true ? ' (figée)' : input.locked === false ? ' (déverrouillée)' : '';
    await this.audit.log({ ...log(c), action: 'regie.cuesheet.update', resourceType: 'regie_cuesheet', resourceId: id, summary: `Conduite « ${before.title} » modifiée${what}` });
    this.changed(id);
    return s;
  }

  @Access('regie', 'regie.cuesheets.delete')
  @Delete('regie/cuesheets/:id')
  async remove(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const s = await this.sheet(c.association.id, id);
    const [n] = await this.db.select({ n: sql<number>`count(*)::int` }).from(regieCues).where(eq(regieCues.cuesheetId, id));
    await this.db.transaction(async (tx) => {
      await tx.delete(driveLinks).where(and(eq(driveLinks.module, 'regie'), eq(driveLinks.entityType, 'cuesheet'), eq(driveLinks.entityId, id)));
      await tx.delete(regieCuesheets).where(eq(regieCuesheets.id, id));
      await this.audit.log({ ...log(c), action: 'regie.cuesheet.delete', resourceType: 'regie_cuesheet', resourceId: id, summary: `Suppression de la conduite « ${s.title} » (${n.n} top(s), séances et journaux compris ; les sons restent dans Drive)` }, tx);
    });
    this.rt.emitRegie(id, 'regie:deleted', { cuesheetId: id });
    return { ok: true };
  }

  /** Copie de travail (nouvelle version) : tops et cartoucheur, sans les séances. */
  @Access('regie', 'regie.cuesheets.create')
  @Post('regie/cuesheets/:id/duplicate')
  async duplicate(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const s = await this.sheet(c.association.id, id);
    const copy = await this.db.transaction(async (tx) => {
      const [n] = await tx.insert(regieCuesheets).values({ associationId: c.association.id, title: `${s.title} (copie)`, showId: s.showId, notes: s.notes, createdBy: c.user.id }).returning();
      const sounds = await tx.select().from(regieSounds).where(eq(regieSounds.cuesheetId, id));
      const map = new Map<string, string>();
      for (const so of sounds) {
        const { id: old, cuesheetId: _c, createdAt: _d, ...rest } = so;
        const [x] = await tx.insert(regieSounds).values({ ...rest, cuesheetId: n.id }).returning({ id: regieSounds.id });
        map.set(old, x.id);
      }
      const cues = await this.cues(id, tx);
      if (cues.length) {
        await tx.insert(regieCues).values(cues.map(({ id: _i, cuesheetId: _c, createdAt: _d, updatedAt: _u, soundId, ...rest }) => ({ ...rest, cuesheetId: n.id, soundId: soundId ? map.get(soundId) ?? null : null })));
      }
      const files = await tx.select({ f: driveLinks.fileId }).from(driveLinks).where(and(eq(driveLinks.module, 'regie'), eq(driveLinks.entityType, 'cuesheet'), eq(driveLinks.entityId, id)));
      if (files.length) await tx.insert(driveLinks).values(files.map((f) => ({ fileId: f.f, module: 'regie', entityType: 'cuesheet', entityId: n.id, createdBy: c.user.id }))).onConflictDoNothing();
      await this.audit.log({ ...log(c), action: 'regie.cuesheet.duplicate', resourceType: 'regie_cuesheet', resourceId: n.id, summary: `Copie de la conduite « ${s.title} » (${cues.length} top(s))` }, tx);
      return n;
    });
    return copy;
  }

  @Access('regie', 'regie.cuesheets.download')
  @Get('regie/cuesheets/:id/cuesheet.pdf')
  async pdf(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response, @Query('department') dept?: string) {
    const s = await this.sheet(c.association.id, id);
    const filter = dept && dept in DEPARTMENTS ? dept : null;
    const cues = (await this.cues(id)).filter((q) => !filter || q.department === filter);
    const [a] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
    const [show] = s.showId ? await this.db.select({ t: shows.title }).from(shows).where(eq(shows.id, s.showId)) : [];
    const pdf = await cuesheetPdf(a, { title: s.title, show: show?.t ?? null }, cues, filter);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="conduite${filter ? `-${filter}` : ''}.pdf"`);
    res.send(pdf);
  }

  /* ============================================================ Tops */

  @Access('regie', 'regie.cuesheets.update')
  @Post('regie/cuesheets/:id/cues')
  async addCue(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    await this.editable(c.association.id, id);
    const input = parse(zCue.extend({ afterCueId: zUuid.nullable().optional() }), body);
    if (input.soundId) await this.assertSound(id, input.soundId);
    const { afterCueId, ...values } = input;
    const q = await this.db.transaction(async (tx) => {
      const list = await this.cues(id, tx);
      let pos = list.length;
      if (afterCueId !== undefined) pos = afterCueId === null ? 0 : list.findIndex((x) => x.id === afterCueId) + 1;
      if (pos < 0) throw BadRequest('UNKNOWN_CUE', 'Top de référence inconnu.');
      const [q] = await tx.insert(regieCues).values({ ...values, cuesheetId: id, position: pos }).returning();
      const order = [...list.slice(0, pos).map((x) => x.id), q.id, ...list.slice(pos).map((x) => x.id)];
      await this.reorder(tx, order);
      await tx.update(regieCuesheets).set({ updatedAt: new Date() }).where(eq(regieCuesheets.id, id));
      return q;
    });
    this.changed(id);
    return q;
  }

  private async reorder(tx: DbOrTx, ids: string[]) {
    if (!ids.length) return;
    await tx.execute(sql`update regie_cues set position = v.pos from (select unnest(array[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::uuid[]) as id, generate_series(0, ${ids.length - 1}) as pos) v where regie_cues.id = v.id`);
  }

  private async assertSound(sheetId: string, soundId: string) {
    const [x] = await this.db.select({ id: regieSounds.id }).from(regieSounds).where(and(eq(regieSounds.id, soundId), eq(regieSounds.cuesheetId, sheetId)));
    if (!x) throw BadRequest('UNKNOWN_SOUND', 'Son inconnu dans cette conduite.');
  }

  @Access('regie', 'regie.cuesheets.update')
  @Patch('regie/cues/:id')
  async updateCue(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const { s } = await this.cueOf(c.association.id, id);
    await this.editable(c.association.id, s.id);
    const input = parse(patchOf(zCue), body);
    if (input.soundId) await this.assertSound(s.id, input.soundId);
    const [q] = await this.db.update(regieCues).set({ ...input, updatedAt: new Date() }).where(eq(regieCues.id, id)).returning();
    await this.db.update(regieCuesheets).set({ updatedAt: new Date() }).where(eq(regieCuesheets.id, s.id));
    this.changed(s.id);
    return q;
  }

  @Access('regie', 'regie.cuesheets.update')
  @Delete('regie/cues/:id')
  async removeCue(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const { q, s } = await this.cueOf(c.association.id, id);
    await this.editable(c.association.id, s.id);
    await this.db.transaction(async (tx) => {
      await tx.delete(regieCues).where(eq(regieCues.id, id));
      await this.reorder(tx, (await this.cues(s.id, tx)).map((x) => x.id));
    });
    await this.audit.log({ ...log(c), action: 'regie.cue.delete', resourceType: 'regie_cuesheet', resourceId: s.id, summary: `Top ${q.number ?? ''} « ${q.label} » supprimé de « ${s.title} »` });
    this.changed(s.id);
    return { ok: true };
  }

  @Access('regie', 'regie.cuesheets.update')
  @Put('regie/cuesheets/:id/order')
  async order(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    await this.editable(c.association.id, id);
    const { cueIds } = parse(z.object({ cueIds: z.array(zUuid).max(5000) }), body);
    const current = (await this.cues(id)).map((x) => x.id);
    if (current.length !== cueIds.length || new Set(cueIds).size !== cueIds.length || cueIds.some((x) => !current.includes(x))) throw BadRequest('ORDER_MISMATCH', 'La liste des tops ne correspond pas à la conduite.');
    await this.db.transaction((tx) => this.reorder(tx, cueIds));
    this.changed(id);
    return { ok: true };
  }

  /** Renumérotation automatique par service (L1, L2… S1, S2…), dans l'ordre de la conduite. */
  @Access('regie', 'regie.cuesheets.update')
  @Post('regie/cuesheets/:id/renumber')
  @HttpCode(200)
  async renumber(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const s = await this.editable(c.association.id, id);
    const counters: Record<string, number> = {};
    await this.db.transaction(async (tx) => {
      for (const q of await this.cues(id, tx)) {
        counters[q.department] = (counters[q.department] ?? 0) + 1;
        await tx.update(regieCues).set({ number: `${DEPARTMENTS[q.department].prefix}${counters[q.department]}` }).where(eq(regieCues.id, q.id));
      }
    });
    await this.audit.log({ ...log(c), action: 'regie.renumber', resourceType: 'regie_cuesheet', resourceId: id, summary: `Renumérotation des tops de « ${s.title} »` });
    this.changed(id);
    return { ok: true };
  }

  /* ============================================================ Cartoucheur */

  private assertCart(c: AssocCtx) {
    if (!isFeatureEnabled(c.modules, 'regie.cart')) throw BadRequest('FEATURE_DISABLED', 'Activez Scenorya Drive pour utiliser le cartoucheur.');
  }

  @Access('regie', 'regie.cuesheets.update')
  @Post('regie/cuesheets/:id/sounds')
  async addSound(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    this.assertCart(c);
    await this.editable(c.association.id, id);
    const input = parse(zSound, body);
    // Le fichier doit avoir été joint à cette conduite (envoyé depuis la Régie, rangé dans Drive).
    const [f] = await this.db.select({ f: driveFiles }).from(driveLinks).innerJoin(driveFiles, eq(driveFiles.id, driveLinks.fileId))
      .where(and(eq(driveLinks.fileId, input.driveFileId), eq(driveLinks.module, 'regie'), eq(driveLinks.entityType, 'cuesheet'), eq(driveLinks.entityId, id), eq(driveFiles.associationId, c.association.id), isNull(driveFiles.deletedAt)));
    if (!f) throw NotFound('Fichier introuvable pour cette conduite.');
    if (!f.f.mime.startsWith('audio/')) throw BadRequest('NOT_AUDIO', 'Ce fichier n’est pas un son (MP3, WAV, OGG, M4A).');
    const [{ n }] = await this.db.select({ n: sql<number>`coalesce(max(${regieSounds.position}), -1)::int + 1` }).from(regieSounds).where(eq(regieSounds.cuesheetId, id));
    const [so] = await this.db.insert(regieSounds).values({ ...input, cuesheetId: id, position: n }).returning();
    this.changed(id);
    return so;
  }

  @Access('regie', 'regie.cuesheets.update')
  @Patch('regie/sounds/:id')
  async updateSound(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const { s } = await this.soundOf(c.association.id, id);
    await this.editable(c.association.id, s.id);
    const input = parse(patchOf(zSound.omit({ driveFileId: true })), body);
    const [so] = await this.db.update(regieSounds).set(input).where(eq(regieSounds.id, id)).returning();
    this.changed(s.id);
    return so;
  }

  @Access('regie', 'regie.cuesheets.update')
  @Delete('regie/sounds/:id')
  async removeSound(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const { so, s } = await this.soundOf(c.association.id, id);
    await this.editable(c.association.id, s.id);
    await this.db.delete(regieSounds).where(eq(regieSounds.id, id));
    await this.audit.log({ ...log(c), action: 'regie.sound.delete', resourceType: 'regie_cuesheet', resourceId: s.id, summary: `Son « ${so.label} » retiré du cartoucheur de « ${s.title} » (le fichier reste dans Drive)` });
    this.changed(s.id);
    return { ok: true };
  }

  /** Lecture d'un son du cartoucheur : réservée aux personnes qui ont accès à la conduite. */
  @Access('regie', 'regie.cuesheets.read')
  @Get('regie/sounds/:id/audio')
  async audio(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response) {
    const { so } = await this.soundOf(c.association.id, id);
    const [f] = so.driveFileId ? await this.db.select().from(driveFiles).where(and(eq(driveFiles.id, so.driveFileId), isNull(driveFiles.deletedAt))) : [];
    if (!f || !(await blobExists(f.sha256))) throw NotFound('Fichier son indisponible (supprimé de Drive ?).');
    res.set({ ...fileHeaders(f.name, f.mime, f.size, true), 'Cache-Control': 'private, max-age=86400' });
    createReadStream(blobPath(f.sha256)).on('error', () => res.destroy()).pipe(res);
  }

  /* ============================================================ Séances en direct */

  private async state(run: Run, extra: Record<string, unknown> = {}) {
    return { runId: run.id, cuesheetId: run.cuesheetId, mode: run.mode, currentCueId: run.currentCueId, standbyCueId: run.standbyCueId, endedAt: run.endedAt, ...extra };
  }

  /** Démarre la séance (une seule à la fois par conduite) ; en mode spectacle, la conduite ne peut plus être modifiée. */
  @Access('regie', 'regie.runs.operate')
  @Post('regie/cuesheets/:id/runs')
  async start(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const s = await this.sheet(c.association.id, id);
    const input = parse(z.object({ mode: z.enum(['rehearsal', 'show']).default('rehearsal'), performanceId: zUuid.nullable().optional() }), body ?? {});
    if (input.performanceId) {
      const [p] = await this.db.select({ id: showPerformances.id }).from(showPerformances).innerJoin(shows, eq(shows.id, showPerformances.showId))
        .where(and(eq(showPerformances.id, input.performanceId), eq(shows.associationId, c.association.id)));
      if (!p) throw NotFound('Représentation introuvable.');
    }
    const run = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`regie-run:${id}`}))`);
      const [open] = await tx.select().from(regieRuns).where(and(eq(regieRuns.cuesheetId, id), isNull(regieRuns.endedAt)));
      if (open) throw Conflict('RUN_ACTIVE', 'Une séance est déjà en cours sur cette conduite : rejoignez-la ou terminez-la.', { runId: open.id });
      const cues = await this.cues(id, tx);
      const [r] = await tx.insert(regieRuns).values({ cuesheetId: id, mode: input.mode, performanceId: input.performanceId ?? null, standbyCueId: cues[0]?.id ?? null, startedBy: c.user.id }).returning();
      await tx.insert(regieRunLog).values({ runId: r.id, kind: 'start', note: input.mode === 'show' ? 'Représentation' : 'Répétition', at: r.startedAt, userId: c.user.id });
      await this.audit.log({ ...log(c), action: 'regie.run.start', resourceType: 'regie_cuesheet', resourceId: id, summary: `Début de ${input.mode === 'show' ? 'représentation' : 'répétition'} sur la conduite « ${s.title} »` }, tx);
      return r;
    });
    this.rt.emitRegie(id, 'regie:state', await this.state(run, { kind: 'start', by: c.user.displayName }));
    return run;
  }

  @Access('regie', 'regie.runs.read')
  @Get('regie/runs/:id')
  async run(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const { r, s } = await this.runOf(c.association.id, id);
    const entries = await this.db.select({ l: regieRunLog, user: users.displayName }).from(regieRunLog).leftJoin(users, eq(users.id, regieRunLog.userId))
      .where(eq(regieRunLog.runId, id)).orderBy(asc(regieRunLog.at), asc(regieRunLog.id));
    const [by] = r.startedBy ? await this.db.select({ n: users.displayName }).from(users).where(eq(users.id, r.startedBy)) : [];
    return { ...r, cuesheet: { id: s.id, title: s.title }, startedByName: by?.n ?? null, log: entries.map((e) => ({ ...e.l, user: e.user })) };
  }

  @Access('regie', 'regie.runs.read')
  @Get('regie/cuesheets/:id/runs')
  async runs(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    await this.sheet(c.association.id, id);
    return this.db.select({ id: regieRuns.id, mode: regieRuns.mode, startedAt: regieRuns.startedAt, endedAt: regieRuns.endedAt, by: users.displayName, gos: sql<number>`(select count(*)::int from regie_run_log l where l.run_id = ${regieRuns.id} and l.kind = 'go')` })
      .from(regieRuns).leftJoin(users, eq(users.id, regieRuns.startedBy)).where(eq(regieRuns.cuesheetId, id)).orderBy(desc(regieRuns.startedAt)).limit(100);
  }

  /**
   * Actions de conduite (GO, retour, saut, attention, note). Accepte un lot : après une coupure
   * réseau, le poste rejoue ses actions avec leur heure d'origine (bornée à la séance).
   */
  @Access('regie', 'regie.runs.operate')
  @Post('regie/runs/:id/actions')
  @HttpCode(200)
  async act(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const { actions } = parse(z.object({ actions: z.array(zAction).min(1).max(500) }), body);
    const result = await this.db.transaction(async (tx) => {
      const [locked] = await tx.select({ r: regieRuns }).from(regieRuns).innerJoin(regieCuesheets, eq(regieCuesheets.id, regieRuns.cuesheetId))
        .where(and(eq(regieRuns.id, id), eq(regieCuesheets.associationId, c.association.id))).for('update');
      if (!locked) throw NotFound('Séance introuvable.');
      let run = locked.r;
      if (run.endedAt) throw Conflict('RUN_ENDED', 'Cette séance est terminée.');
      const cues = await this.cues(run.cuesheetId, tx);
      const index = new Map(cues.map((q, i) => [q.id, i]));
      const now = Date.now();
      for (const a of actions) {
        // Heure d'origine bornée à la séance : jamais avant son début ni dans le futur.
        const at = a.at ? new Date(Math.min(Math.max(a.at.getTime(), run.startedAt.getTime()), now)) : new Date();
        let current = run.currentCueId;
        let cue = a.cueId ? cues[index.get(a.cueId) ?? -1] : undefined;
        if (a.cueId && !cue) throw BadRequest('UNKNOWN_CUE', 'Top inconnu dans cette conduite.');
        if (a.kind === 'go') {
          // GO sans top précisé : le top en attente, sinon le suivant.
          cue ??= cues[run.standbyCueId ? index.get(run.standbyCueId) ?? 0 : (current ? (index.get(current) ?? -1) + 1 : 0)];
          if (!cue) throw BadRequest('END_OF_SHEET', 'Fin de la conduite : plus de top à envoyer.');
          current = cue.id;
        } else if (a.kind === 'back') {
          const i = current ? index.get(current) ?? 0 : 0;
          cue = i > 0 ? cues[i - 1] : undefined;
          current = cue?.id ?? null;
        } else if (a.kind === 'jump') {
          if (!cue) throw BadRequest('UNKNOWN_CUE', 'Précisez le top.');
          current = cue.id;
        }
        const standby = a.kind === 'standby' && cue ? cue.id : (a.kind === 'note' ? run.standbyCueId : cues[current ? (index.get(current) ?? -1) + 1 : 0]?.id ?? null);
        [run] = await tx.update(regieRuns).set({ currentCueId: current, standbyCueId: standby }).where(eq(regieRuns.id, id)).returning();
        await tx.insert(regieRunLog).values({ runId: id, kind: a.kind, cueId: cue?.id ?? null, cueLabel: cue ? `${cue.number ? `${cue.number} — ` : ''}${cue.label}` : null, note: a.note ?? null, at, userId: c.user.id });
      }
      return { run, last: actions[actions.length - 1] };
    });
    const st = await this.state(result.run, { kind: result.last.kind, by: c.user.displayName, at: new Date() });
    this.rt.emitRegie(result.run.cuesheetId, 'regie:state', st);
    return st;
  }

  @Access('regie', 'regie.runs.operate')
  @Post('regie/runs/:id/end')
  @HttpCode(200)
  async end(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const { r, s } = await this.runOf(c.association.id, id);
    if (r.endedAt) throw Conflict('RUN_ENDED', 'Cette séance est déjà terminée.');
    const { report } = parse(z.object({ report: zOptText(8000) }), body ?? {});
    const [run] = await this.db.transaction(async (tx) => {
      await tx.insert(regieRunLog).values({ runId: id, kind: 'end', at: new Date(), userId: c.user.id });
      await this.audit.log({ ...log(c), action: 'regie.run.end', resourceType: 'regie_cuesheet', resourceId: s.id, summary: `Fin de ${r.mode === 'show' ? 'représentation' : 'répétition'} sur « ${s.title} »` }, tx);
      return tx.update(regieRuns).set({ endedAt: new Date(), report: report ?? null }).where(eq(regieRuns.id, id)).returning();
    });
    this.rt.emitRegie(s.id, 'regie:state', await this.state(run, { kind: 'end', by: c.user.displayName }));
    return run;
  }

  @Access('regie', 'regie.runs.operate')
  @Patch('regie/runs/:id')
  async updateReport(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    await this.runOf(c.association.id, id);
    const { report } = parse(z.object({ report: zOptText(8000) }), body);
    const [r] = await this.db.update(regieRuns).set({ report: report ?? null }).where(eq(regieRuns.id, id)).returning();
    return r;
  }

  @Access('regie', 'regie.runs.operate')
  @Delete('regie/runs/:id')
  async removeRun(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    const { r, s } = await this.runOf(c.association.id, id);
    await this.db.delete(regieRuns).where(eq(regieRuns.id, id));
    await this.audit.log({ ...log(c), action: 'regie.run.delete', resourceType: 'regie_cuesheet', resourceId: s.id, summary: `Suppression d’une séance du ${r.startedAt.toISOString().slice(0, 10)} (« ${s.title} ») et de son journal` });
    if (!r.endedAt) this.rt.emitRegie(s.id, 'regie:state', { runId: id, cuesheetId: s.id, endedAt: new Date(), kind: 'end' });
    return { ok: true };
  }

  @Access('regie', 'regie.runs.read')
  @Get('regie/runs/:id/report.pdf')
  async reportPdf(@AssocContext() c: AssocCtx, @Param('id') id: string, @Res() res: Response) {
    const d = await this.run(c, id);
    const [a] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
    let perf: string | null = null;
    if (d.performanceId) {
      const [p] = await this.db.select({ t: shows.title, at: showPerformances.startAt }).from(showPerformances).innerJoin(shows, eq(shows.id, showPerformances.showId)).where(eq(showPerformances.id, d.performanceId));
      if (p) perf = `${p.t}, représentation du ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(p.at)}`;
    }
    const pdf = await runReportPdf(a, d.cuesheet, { mode: d.mode, startedAt: d.startedAt, endedAt: d.endedAt, report: d.report, performance: perf, by: d.startedByName }, d.log);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rapport-${d.startedAt.toISOString().slice(0, 10)}.pdf"`);
    res.send(pdf);
  }
}
