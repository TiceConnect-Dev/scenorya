import { MODULES, MODULES_BY_ID, ModuleDefinition, ModuleId } from './modules';

/**
 * États configurables par une association :
 *  - active   : module utilisable en lecture et écriture
 *  - readonly : mode clôture — consultation/archives seulement, écritures refusées
 *  - inactive : module désactivé (données conservées, accès refusé)
 */
export type ConfiguredState = 'active' | 'readonly' | 'inactive';

/** États effectifs après résolution. */
export type EffectiveState =
  | 'required' // module de socle
  | 'active'
  | 'readonly'
  | 'inactive'
  | 'missing_dependency' // configuré actif mais une dépendance stricte est inutilisable
  | 'unavailable'; // désactivé au niveau de l'instance par un superadministrateur

export interface ResolvedModule {
  id: ModuleId;
  configured: ConfiguredState;
  state: EffectiveState;
  /** Les routes de lecture sont autorisées. */
  usable: boolean;
  /** Les routes d'écriture sont autorisées. */
  writable: boolean;
  missing: ModuleId[];
  features: Record<string, boolean>;
}

export type ResolvedModules = Record<ModuleId, ResolvedModule>;

export interface ResolveInput {
  /** Modules désactivés au niveau de l'instance (les modules de socle sont ignorés). */
  instanceDisabled?: Iterable<ModuleId>;
  /** Configuration de l'association ; un module absent est considéré inactif. */
  config: Partial<Record<ModuleId, ConfiguredState>>;
}

/** Tri topologique des modules selon les dépendances strictes. Lève une erreur en cas de cycle. */
export function topologicalOrder(modules: ModuleDefinition[] = MODULES): ModuleId[] {
  const order: ModuleId[] = [];
  const state = new Map<ModuleId, 'visiting' | 'done'>();
  const byId = new Map(modules.map((m) => [m.id, m]));
  const visit = (id: ModuleId, path: ModuleId[]) => {
    const s = state.get(id);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`Cycle de dépendances : ${[...path, id].join(' → ')}`);
    state.set(id, 'visiting');
    const def = byId.get(id);
    if (!def) throw new Error(`Module inconnu dans le graphe : ${id}`);
    for (const dep of def.requires) visit(dep, [...path, id]);
    state.set(id, 'done');
    order.push(id);
  };
  for (const m of modules) visit(m.id, []);
  return order;
}

const ORDER = topologicalOrder();

export function resolveModules(input: ResolveInput): ResolvedModules {
  const disabled = new Set(input.instanceDisabled ?? []);
  const result = {} as ResolvedModules;

  for (const id of ORDER) {
    const def = MODULES_BY_ID[id];
    const configured: ConfiguredState = def.core ? 'active' : input.config[id] ?? 'inactive';
    let state: EffectiveState;
    let missing: ModuleId[] = [];

    if (def.core) state = 'required';
    else if (disabled.has(id)) state = 'unavailable';
    else if (configured === 'inactive') state = 'inactive';
    else {
      missing = def.requires.filter((dep) => !result[dep].usable);
      state = missing.length > 0 ? 'missing_dependency' : configured;
    }
    const usable = state === 'required' || state === 'active' || state === 'readonly';
    result[id] = {
      id,
      configured,
      state,
      usable,
      writable: state === 'required' || state === 'active',
      missing,
      features: {},
    };
  }

  // Fonctionnalités conditionnelles (calculées une fois tous les états connus).
  for (const def of MODULES) {
    const r = result[def.id];
    for (const f of def.features) {
      r.features[f.id] = r.usable && f.requires.every((dep) => result[dep].usable);
    }
  }
  return result;
}

export function isFeatureEnabled(resolved: ResolvedModules, featureId: string): boolean {
  const moduleId = featureId.split('.')[0] as ModuleId;
  return Boolean(resolved[moduleId]?.features[featureId]);
}

/** Toutes les dépendances strictes (transitives) d'un module. */
export function transitiveRequirements(id: ModuleId): ModuleId[] {
  const out = new Set<ModuleId>();
  const walk = (m: ModuleId) => {
    for (const dep of MODULES_BY_ID[m].requires) {
      if (!out.has(dep)) {
        out.add(dep);
        walk(dep);
      }
    }
  };
  walk(id);
  return ORDER.filter((m) => out.has(m));
}

/** Tous les modules qui dépendent strictement (transitivement) d'un module. */
export function transitiveDependents(id: ModuleId): ModuleId[] {
  const out = new Set<ModuleId>();
  const walk = (m: ModuleId) => {
    for (const def of MODULES) {
      if (def.requires.includes(m) && !out.has(def.id)) {
        out.add(def.id);
        walk(def.id);
      }
    }
  };
  walk(id);
  return ORDER.filter((m) => out.has(m));
}

export interface ActivationPlan {
  target: ModuleId;
  /** Dépendances qui seront activées en même temps (confirmation requise si non vide). */
  toActivate: ModuleId[];
  /** Dépendances impossibles à activer (désactivées au niveau de l'instance). */
  blockers: { module: ModuleId; reason: string }[];
  /** Fonctionnalités qui deviendront disponibles dans d'autres modules. */
  unlockedFeatures: { module: ModuleId; feature: string; label: string }[];
}

export function planActivation(input: ResolveInput, target: ModuleId): ActivationPlan {
  const def = MODULES_BY_ID[target];
  const current = resolveModules(input);
  const disabled = new Set(input.instanceDisabled ?? []);
  const blockers: ActivationPlan['blockers'] = [];
  if (def.core) blockers.push({ module: target, reason: 'Module de socle, toujours actif.' });
  if (disabled.has(target)) blockers.push({ module: target, reason: "Module désactivé au niveau de l'instance." });

  const toActivate = transitiveRequirements(target).filter((dep) => current[dep].state !== 'active' && current[dep].state !== 'required');
  for (const dep of toActivate) {
    if (disabled.has(dep)) blockers.push({ module: dep, reason: "Dépendance désactivée au niveau de l'instance." });
  }

  const next = resolveModules({
    ...input,
    config: { ...input.config, ...Object.fromEntries([...toActivate, target].map((m) => [m, 'active'])) },
  });
  const unlockedFeatures: ActivationPlan['unlockedFeatures'] = [];
  for (const m of MODULES) {
    for (const f of m.features) {
      if (!current[m.id].features[f.id] && next[m.id].features[f.id]) {
        unlockedFeatures.push({ module: m.id, feature: f.id, label: f.label });
      }
    }
  }
  return { target, toActivate, blockers, unlockedFeatures };
}

export interface DeactivationPlan {
  target: ModuleId;
  mode: 'inactive' | 'readonly';
  /** Modules actifs qui dépendent strictement de la cible et devront changer d'état aussi. */
  dependents: ModuleId[];
  /** Fonctionnalités d'autres modules qui seront indisponibles. */
  lostFeatures: { module: ModuleId; feature: string; label: string }[];
  blockers: { module: ModuleId; reason: string }[];
}

export function planDeactivation(input: ResolveInput, target: ModuleId, mode: 'inactive' | 'readonly' = 'inactive'): DeactivationPlan {
  const def = MODULES_BY_ID[target];
  const current = resolveModules(input);
  const blockers: DeactivationPlan['blockers'] = [];
  if (def.core) blockers.push({ module: target, reason: 'Module de socle : il ne peut pas être désactivé.' });

  // Passer en lecture seule garde la cible "utilisable" : les dépendants restent fonctionnels.
  const dependents =
    mode === 'readonly'
      ? []
      : transitiveDependents(target).filter((m) => current[m].configured !== 'inactive');

  const nextConfig = { ...input.config, [target]: mode } as ResolveInput['config'];
  for (const d of dependents) nextConfig[d] = 'inactive';
  const next = resolveModules({ ...input, config: nextConfig });
  const lostFeatures: DeactivationPlan['lostFeatures'] = [];
  for (const m of MODULES) {
    if (m.id === target || dependents.includes(m.id)) continue;
    for (const f of m.features) {
      if (current[m.id].features[f.id] && !next[m.id].features[f.id]) {
        lostFeatures.push({ module: m.id, feature: f.id, label: f.label });
      }
    }
  }
  return { target, mode, dependents, lostFeatures, blockers };
}
