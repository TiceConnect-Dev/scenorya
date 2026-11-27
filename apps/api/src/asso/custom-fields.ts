import { BadRequest } from '../common/errors';

export interface FieldDef {
  key: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
  sensitive: boolean;
  archivedAt: Date | null;
}

/**
 * Valide les valeurs des champs personnalisés d'une fiche.
 * - les clés inconnues ou archivées sont refusées ;
 * - sans le droit « données sensibles », les champs sensibles sont ignorés en écriture ;
 * - `previous` conserve les valeurs non transmises (mise à jour partielle).
 */
export function validateCustom(defs: FieldDef[], input: Record<string, unknown> | undefined, opts: { sensitive: boolean; previous?: Record<string, unknown>; partial: boolean }) {
  const active = defs.filter((d) => !d.archivedAt);
  const byKey = new Map(active.map((d) => [d.key, d]));
  const out: Record<string, unknown> = { ...(opts.previous ?? {}) };
  const errors: { path: string; message: string }[] = [];
  for (const [key, raw] of Object.entries(input ?? {})) {
    const def = byKey.get(key);
    if (!def) {
      errors.push({ path: `custom.${key}`, message: 'Champ inconnu' });
      continue;
    }
    if (def.sensitive && !opts.sensitive) continue;
    if (raw === null || raw === '' || raw === undefined) {
      delete out[key];
      continue;
    }
    switch (def.type) {
      case 'text':
        if (typeof raw !== 'string' || raw.length > 1000) errors.push({ path: `custom.${key}`, message: `${def.label} : texte attendu (1000 caractères max)` });
        else out[key] = raw.trim();
        break;
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
        if (!Number.isFinite(n)) errors.push({ path: `custom.${key}`, message: `${def.label} : nombre attendu` });
        else out[key] = n;
        break;
      }
      case 'date':
        if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) errors.push({ path: `custom.${key}`, message: `${def.label} : date AAAA-MM-JJ attendue` });
        else out[key] = raw;
        break;
      case 'boolean':
        if (typeof raw !== 'boolean') errors.push({ path: `custom.${key}`, message: `${def.label} : oui/non attendu` });
        else out[key] = raw;
        break;
      case 'select':
        if (typeof raw !== 'string' || !def.options.includes(raw)) errors.push({ path: `custom.${key}`, message: `${def.label} : valeur hors liste` });
        else out[key] = raw;
        break;
      default:
        errors.push({ path: `custom.${key}`, message: 'Type de champ inconnu' });
    }
  }
  for (const def of active) {
    if (def.required && !(def.sensitive && !opts.sensitive) && (out[def.key] === undefined || out[def.key] === '')) {
      if (!opts.partial || (input && def.key in input)) errors.push({ path: `custom.${def.key}`, message: `${def.label} est obligatoire` });
    }
  }
  if (errors.length) throw BadRequest('VALIDATION_ERROR', 'Données invalides.', errors);
  return out;
}

/** Masque les valeurs des champs sensibles. */
export function visibleCustom(defs: FieldDef[], values: Record<string, unknown>, sensitive: boolean) {
  if (sensitive) return values;
  const hidden = new Set(defs.filter((d) => d.sensitive).map((d) => d.key));
  return Object.fromEntries(Object.entries(values).filter(([k]) => !hidden.has(k)));
}
