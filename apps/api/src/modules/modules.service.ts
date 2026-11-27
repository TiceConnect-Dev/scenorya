import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { and, eq, sql, desc } from 'drizzle-orm';
import {
  MODULES, MODULES_BY_ID, ModuleId, ConfiguredState, ResolvedModules, isModuleId,
  resolveModules, planActivation, planDeactivation, ResolveInput,
} from '@scenorya/shared';
import { DB, Db, DbOrTx } from '../db/db';
import { associationModules, associations, instanceModules, moduleConfigHistory, users } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { BadRequest, Conflict, NotFound } from '../common/errors';

export interface ModuleImpact {
  module: ModuleId;
  /** blocking : interdit la désactivation (la clôture en lecture seule reste possible). */
  level: 'blocking' | 'warning' | 'info';
  message: string;
}

/** Fournisseur de conséquences de désactivation, déclaré par chaque module métier. */
export interface ModuleImpactProvider {
  module: ModuleId;
  check(db: Db, associationId: string): Promise<ModuleImpact[]>;
}

export interface ModuleChangeEvent {
  associationId: string | null;
  changes: { module: ModuleId; from: string | null; to: string }[];
}

interface Actor {
  id: string;
  label: string;
  ip?: string | null;
}

@Injectable()
export class ModulesService {
  /** Émet `changed` (ModuleChangeEvent) — consommé par la passerelle temps réel. */
  readonly events = new EventEmitter();
  private cache = new Map<string, { at: number; resolved: ResolvedModules }>();
  private instanceCache: { at: number; disabled: ModuleId[] } | null = null;
  private providers: ModuleImpactProvider[] = [];
  private static TTL = 30_000;

  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService) {}

  registerImpactProvider(p: ModuleImpactProvider) {
    this.providers.push(p);
  }

  invalidate(associationId?: string) {
    if (associationId) this.cache.delete(associationId);
    else this.cache.clear();
  }

  async instanceDisabled(force = false): Promise<ModuleId[]> {
    if (!force && this.instanceCache && Date.now() - this.instanceCache.at < ModulesService.TTL) return this.instanceCache.disabled;
    const rows = await this.db.select().from(instanceModules).where(eq(instanceModules.enabled, false));
    const disabled = rows.map((r) => r.moduleId).filter(isModuleId).filter((m) => !MODULES_BY_ID[m].core);
    this.instanceCache = { at: Date.now(), disabled };
    return disabled;
  }

  private async input(associationId: string, db: DbOrTx = this.db): Promise<ResolveInput> {
    const rows = await db.select().from(associationModules).where(eq(associationModules.associationId, associationId));
    const config: ResolveInput['config'] = {};
    for (const r of rows) if (isModuleId(r.moduleId)) config[r.moduleId] = r.state as ConfiguredState;
    return { config, instanceDisabled: await this.instanceDisabled(db !== this.db) };
  }

  /** États résolus des modules d'une association (mis en cache, invalidé à chaque changement). */
  async resolved(associationId: string): Promise<ResolvedModules> {
    const hit = this.cache.get(associationId);
    if (hit && Date.now() - hit.at < ModulesService.TTL) return hit.resolved;
    const resolved = resolveModules(await this.input(associationId));
    this.cache.set(associationId, { at: Date.now(), resolved });
    return resolved;
  }

  async catalogue(associationId: string) {
    const resolved = await this.resolved(associationId);
    const instanceDisabled = new Set(await this.instanceDisabled());
    const rows = await this.db.select().from(associationModules).where(eq(associationModules.associationId, associationId));
    const byId = new Map(rows.map((r) => [r.moduleId, r]));
    return MODULES.map((m) => ({
      id: m.id,
      resolved: resolved[m.id],
      instanceEnabled: m.core || !instanceDisabled.has(m.id),
      activatedAt: byId.get(m.id)?.activatedAt ?? null,
      deactivatedAt: byId.get(m.id)?.deactivatedAt ?? null,
      settings: byId.get(m.id)?.settings ?? {},
    }));
  }

  async impacts(associationId: string, modules: ModuleId[]): Promise<ModuleImpact[]> {
    const out: ModuleImpact[] = [];
    for (const p of this.providers) if (modules.includes(p.module)) out.push(...(await p.check(this.db, associationId)));
    return out;
  }

  private assertModule(id: string): ModuleId {
    if (!isModuleId(id)) throw NotFound('Module inconnu.');
    return id;
  }

  async previewActivation(associationId: string, id: string) {
    const target = this.assertModule(id);
    return planActivation(await this.input(associationId), target);
  }

  async previewDeactivation(associationId: string, id: string, mode: 'inactive' | 'readonly') {
    const target = this.assertModule(id);
    const plan = planDeactivation(await this.input(associationId), target, mode);
    const impacts = mode === 'inactive' ? await this.impacts(associationId, [target, ...plan.dependents]) : [];
    const blocking = impacts.filter((i) => i.level === 'blocking');
    return { ...plan, impacts, canProceed: plan.blockers.length === 0 && blocking.length === 0 };
  }

  private async lock(tx: DbOrTx, associationId: string | null) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'modules:' + (associationId ?? 'instance')}))`);
  }

  private async writeState(tx: DbOrTx, associationId: string, module: ModuleId, to: ConfiguredState, actor: Actor | null, reason: string) {
    const [current] = await tx
      .select()
      .from(associationModules)
      .where(and(eq(associationModules.associationId, associationId), eq(associationModules.moduleId, module)));
    const from = current?.state ?? null;
    if (from === to) return null;
    const now = new Date();
    if (current) {
      await tx
        .update(associationModules)
        .set({
          state: to,
          updatedAt: now,
          updatedBy: actor?.id ?? null,
          ...(to === 'active' ? { activatedAt: now } : {}),
          ...(to === 'inactive' ? { deactivatedAt: now } : {}),
        })
        .where(and(eq(associationModules.associationId, associationId), eq(associationModules.moduleId, module)));
    } else {
      await tx.insert(associationModules).values({
        associationId, moduleId: module, state: to, updatedBy: actor?.id ?? null,
        activatedAt: to === 'active' ? now : null,
      });
    }
    await tx.insert(moduleConfigHistory).values({ associationId, moduleId: module, oldState: from, newState: to, actorId: actor?.id ?? null, reason });
    return { module, from, to };
  }

  private async finish(associationId: string, changes: ModuleChangeEvent['changes'], actor: Actor | null, tx: DbOrTx, action: string) {
    if (changes.length === 0) return;
    await this.audit.log(
      {
        associationId,
        actorId: actor?.id ?? null,
        actorLabel: actor?.label ?? 'système',
        action,
        resourceType: 'module',
        resourceId: changes.map((c) => c.module).join(','),
        summary: changes.map((c) => `${MODULES_BY_ID[c.module].name} : ${c.from ?? 'non configuré'} → ${c.to}`).join(' ; '),
        data: { changes },
        ip: actor?.ip ?? null,
      },
      tx,
    );
  }

  private emit(event: ModuleChangeEvent) {
    if (event.changes.length === 0) return;
    if (event.associationId) this.invalidate(event.associationId);
    else this.invalidate();
    this.events.emit('changed', event);
  }

  async activate(associationId: string, id: string, opts: { confirmDependencies?: boolean }, actor: Actor) {
    const target = this.assertModule(id);
    const changes = await this.db.transaction(async (tx) => {
      await this.lock(tx, associationId);
      const plan = planActivation(await this.input(associationId, tx), target);
      if (plan.blockers.length) throw Conflict('MODULE_ACTIVATION_BLOCKED', 'Activation impossible.', plan.blockers);
      if (plan.toActivate.length && !opts.confirmDependencies) {
        throw Conflict('DEPENDENCIES_CONFIRMATION_REQUIRED', 'Des dépendances doivent être activées : confirmation requise.', plan);
      }
      const out: ModuleChangeEvent['changes'] = [];
      for (const m of [...plan.toActivate, target]) {
        const c = await this.writeState(tx, associationId, m, 'active', actor, m === target ? 'activation' : `dépendance de ${target}`);
        if (c) out.push(c);
      }
      await this.finish(associationId, out, actor, tx, 'module.activate');
      return out;
    });
    this.emit({ associationId, changes });
    return { changes, resolved: await this.resolved(associationId) };
  }

  async deactivate(
    associationId: string,
    id: string,
    opts: { mode: 'inactive' | 'readonly'; confirmDependents?: boolean; acknowledgeWarnings?: boolean },
    actor: Actor,
  ) {
    const target = this.assertModule(id);
    const changes = await this.db.transaction(async (tx) => {
      await this.lock(tx, associationId);
      const plan = planDeactivation(await this.input(associationId, tx), target, opts.mode);
      if (plan.blockers.length) throw Conflict('MODULE_DEACTIVATION_BLOCKED', 'Désactivation impossible.', plan.blockers);
      const impacts = await this.impacts(associationId, [target, ...plan.dependents]);
      const blocking = opts.mode === 'inactive' ? impacts.filter((i) => i.level === 'blocking') : [];
      if (blocking.length) {
        throw Conflict('ACTIVE_RECORDS', 'Des dossiers actifs doivent être clôturés ou traités avant la désactivation. Le mode lecture seule reste possible.', blocking);
      }
      if (plan.dependents.length && !opts.confirmDependents) {
        throw Conflict('DEPENDENTS_CONFIRMATION_REQUIRED', 'Des modules dépendants seront aussi désactivés : confirmation requise.', plan);
      }
      // En clôture (lecture seule), les données restent consultables : pas de confirmation requise.
      if (opts.mode === 'inactive' && impacts.some((i) => i.level === 'warning') && !opts.acknowledgeWarnings) {
        throw Conflict('WARNINGS_ACKNOWLEDGEMENT_REQUIRED', 'Des conséquences doivent être confirmées.', impacts);
      }
      const out: ModuleChangeEvent['changes'] = [];
      // Les dépendants d'abord, puis la cible : jamais de désactivation silencieuse.
      for (const m of [...plan.dependents].reverse()) {
        const c = await this.writeState(tx, associationId, m, 'inactive', actor, `dépendant de ${target}`);
        if (c) out.push(c);
      }
      const c = await this.writeState(tx, associationId, target, opts.mode, actor, opts.mode === 'readonly' ? 'clôture (lecture seule)' : 'désactivation');
      if (c) out.push(c);
      await this.finish(associationId, out, actor, tx, opts.mode === 'readonly' ? 'module.readonly' : 'module.deactivate');
      return out;
    });
    this.emit({ associationId, changes });
    return { changes, resolved: await this.resolved(associationId) };
  }

  /** Configuration initiale (assistant d'installation ou nouvelle association). */
  async initialize(tx: DbOrTx, associationId: string, modules: ModuleId[], actor: Actor | null) {
    const wanted = new Set<ModuleId>();
    for (const m of modules) {
      if (MODULES_BY_ID[m].core) continue;
      // Ajoute les dépendances strictes manquantes.
      const plan = planActivation({ config: Object.fromEntries([...wanted].map((w) => [w, 'active'])) }, m);
      plan.toActivate.forEach((d) => wanted.add(d));
      wanted.add(m);
    }
    const out: ModuleChangeEvent['changes'] = [];
    for (const m of MODULES) {
      if (m.core) continue;
      const c = await this.writeState(tx, associationId, m.id, wanted.has(m.id) ? 'active' : 'inactive', actor, 'configuration initiale');
      if (c) out.push(c);
    }
    await this.finish(associationId, out, actor, tx, 'module.initialize');
    this.invalidate(associationId);
    return [...wanted];
  }

  /* ---------------------------------------------------- Niveau instance */

  async instanceCatalogue() {
    const disabled = new Set(await this.instanceDisabled(true));
    const usage = await this.db
      .select({ moduleId: associationModules.moduleId, n: sql<number>`count(*)::int` })
      .from(associationModules)
      .where(sql`${associationModules.state} <> 'inactive'`)
      .groupBy(associationModules.moduleId);
    const used = new Map(usage.map((u) => [u.moduleId, u.n]));
    return MODULES.map((m) => ({ id: m.id, enabled: m.core || !disabled.has(m.id), core: m.core, associationsUsing: used.get(m.id) ?? 0 }));
  }

  async setInstanceModule(id: string, enabled: boolean, actor: Actor) {
    const target = this.assertModule(id);
    if (MODULES_BY_ID[target].core) throw BadRequest('CORE_MODULE', 'Les modules de socle ne peuvent pas être désactivés.');
    await this.db.transaction(async (tx) => {
      await this.lock(tx, null);
      const [current] = await tx.select().from(instanceModules).where(eq(instanceModules.moduleId, target));
      const from = current ? current.enabled : true;
      if (from === enabled) return;
      await tx
        .insert(instanceModules)
        .values({ moduleId: target, enabled, updatedBy: actor.id })
        .onConflictDoUpdate({ target: instanceModules.moduleId, set: { enabled, updatedAt: new Date(), updatedBy: actor.id } });
      await tx.insert(moduleConfigHistory).values({ associationId: null, moduleId: target, oldState: from ? 'enabled' : 'disabled', newState: enabled ? 'enabled' : 'disabled', actorId: actor.id, reason: 'instance' });
      await this.audit.log(
        {
          associationId: null, actorId: actor.id, actorLabel: actor.label, action: enabled ? 'instance.module.enable' : 'instance.module.disable',
          resourceType: 'module', resourceId: target,
          summary: `${MODULES_BY_ID[target].name} ${enabled ? 'rendu disponible' : 'rendu indisponible'} pour toute l'instance`,
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
    this.instanceCache = null;
    this.emit({ associationId: null, changes: [{ module: target, from: null, to: enabled ? 'enabled' : 'disabled' }] });
    return this.instanceCatalogue();
  }

  async history(associationId: string, limit = 100) {
    return this.db
      .select({ h: moduleConfigHistory, actor: users.displayName })
      .from(moduleConfigHistory)
      .leftJoin(users, eq(users.id, moduleConfigHistory.actorId))
      .where(eq(moduleConfigHistory.associationId, associationId))
      .orderBy(desc(moduleConfigHistory.id))
      .limit(limit);
  }

  async associationExists(id: string) {
    const [a] = await this.db.select({ id: associations.id }).from(associations).where(eq(associations.id, id));
    return Boolean(a);
  }
}
