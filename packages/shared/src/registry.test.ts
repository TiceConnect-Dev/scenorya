import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MODULES, MODULE_IDS, MODULE_PROFILES, MODULES_BY_ID, ModuleDefinition,
  topologicalOrder, resolveModules, planActivation, planDeactivation, isFeatureEnabled,
  grantsCover, isValidGrant, canSeeModule, ROLE_TEMPLATES, PERMISSION_KEYS,
} from './index';

const brandingJson = JSON.parse(readFileSync(join(__dirname, '../../../branding/modules.json'), 'utf8')) as any[];

describe('registre des modules', () => {
  it('contient les 22 modules du pack officiel, avec leurs couleurs, routes et permissions', () => {
    expect(MODULES).toHaveLength(22);
    expect(MODULE_IDS).toHaveLength(22);
    for (const b of brandingJson) {
      const m = MODULES_BY_ID[b.id as keyof typeof MODULES_BY_ID];
      expect(m, b.id).toBeDefined();
      expect(m.name).toBe(b.name);
      expect(m.color).toBe(b.color);
      expect(m.route).toBe(b.route);
      expect(m.permission).toBe(b.permission);
      expect(m.core).toBe(b.core);
      expect(m.tagline).toBe(b.description);
      expect(m.assets.source.logo).toBe('/branding/' + b.logo);
      expect(m.assets.source.logoDark).toBe('/branding/' + b.logoDark);
      expect(m.assets.source.icon).toBe('/branding/' + b.icon);
      expect(m.assets.outline).toBe('/branding/' + b.outlineIcon);
      expect(m.assets.flat).toBe('/branding/' + b.flatIcon);
      // Tous les fichiers référencés existent localement (aucune dépendance externe).
      for (const path of [m.assets.logo, m.assets.logoDark, m.assets.icon, m.assets.flat, m.assets.outline]) {
        expect(existsSync(join(__dirname, '../../..', path)), path).toBe(true);
      }
    }
  });

  it("n'a pas de cycle de dépendances et ne référence que des modules connus", () => {
    expect(topologicalOrder()).toHaveLength(22);
    for (const m of MODULES) {
      for (const d of [...m.requires, ...m.integrations, ...m.features.flatMap((f) => f.requires)]) {
        expect(MODULES_BY_ID[d], `${m.id} → ${d}`).toBeDefined();
      }
      expect(m.requires).not.toContain(m.id);
    }
  });

  it('détecte un cycle introduit artificiellement', () => {
    const a = { ...MODULES_BY_ID.scan, requires: ['tickets'] } as ModuleDefinition;
    const b = { ...MODULES_BY_ID.tickets, requires: ['scan'] } as ModuleDefinition;
    expect(() => topologicalOrder([a, b])).toThrow(/Cycle/);
  });

  it('les modules de socle sont toujours requis, même si une config tente de les désactiver', () => {
    const r = resolveModules({ config: { hub: 'inactive', admin: 'inactive' } as any, instanceDisabled: ['system'] });
    expect(r.hub.state).toBe('required');
    expect(r.admin.state).toBe('required');
    expect(r.system.state).toBe('required');
    expect(r.asso.state).toBe('inactive');
  });

  it('Scan sans Tickets est en dépendance manquante et inutilisable', () => {
    const r = resolveModules({ config: { scan: 'active' } });
    expect(r.scan.state).toBe('missing_dependency');
    expect(r.scan.missing).toEqual(['tickets']);
    expect(r.scan.usable).toBe(false);
  });

  it('une dépendance en lecture seule reste satisfaisante', () => {
    const r = resolveModules({ config: { scan: 'active', tickets: 'readonly' } });
    expect(r.scan.state).toBe('active');
    expect(r.tickets.writable).toBe(false);
  });

  it("un module désactivé au niveau de l'instance est indisponible et casse ses dépendants", () => {
    const r = resolveModules({ config: { stock: 'active', maintenance: 'active' }, instanceDisabled: ['stock'] });
    expect(r.stock.state).toBe('unavailable');
    expect(r.maintenance.state).toBe('missing_dependency');
  });

  it('fonctionnalités conditionnelles : caisse sans billetterie, bloc billetterie Web, prêts Booking', () => {
    const r1 = resolveModules({ config: { pos: 'active', web: 'active', booking: 'active' } });
    expect(r1.pos.usable).toBe(true);
    expect(isFeatureEnabled(r1, 'pos.ticketSales')).toBe(false);
    expect(isFeatureEnabled(r1, 'web.ticketingBlock')).toBe(false);
    expect(isFeatureEnabled(r1, 'booking.equipmentLoans')).toBe(false);
    const r2 = resolveModules({ config: { pos: 'active', web: 'active', booking: 'active', tickets: 'active', stock: 'active' } });
    expect(isFeatureEnabled(r2, 'pos.ticketSales')).toBe(true);
    expect(isFeatureEnabled(r2, 'web.ticketingBlock')).toBe(true);
    expect(isFeatureEnabled(r2, 'booking.equipmentLoans')).toBe(true);
  });

  it("Tickets et Régie n'imposent pas Show ; Finance ne dépend pas de POS", () => {
    expect(MODULES_BY_ID.tickets.requires).not.toContain('show');
    expect(MODULES_BY_ID.regie.requires).not.toContain('show');
    expect(MODULES_BY_ID.finance.requires).not.toContain('pos');
    const r = resolveModules({ config: { tickets: 'active', regie: 'active', finance: 'active' } });
    expect(r.tickets.state).toBe('active');
    expect(r.regie.state).toBe('active');
    expect(r.finance.state).toBe('active');
  });
});

describe("plans d'activation et de désactivation", () => {
  it('activer Maintenance propose Stock ; activer Scan propose Tickets', () => {
    expect(planActivation({ config: {} }, 'maintenance').toActivate).toEqual(['stock']);
    const p = planActivation({ config: {} }, 'scan');
    expect(p.toActivate).toEqual(['tickets']);
    expect(p.blockers).toEqual([]);
  });

  it("bloque l'activation si une dépendance est désactivée au niveau de l'instance", () => {
    const p = planActivation({ config: {}, instanceDisabled: ['tickets'] }, 'scan');
    expect(p.blockers.map((b) => b.module)).toContain('tickets');
  });

  it('liste les fonctionnalités débloquées', () => {
    const p = planActivation({ config: { pos: 'active' } }, 'tickets');
    expect(p.unlockedFeatures.map((f) => f.feature)).toContain('pos.ticketSales');
  });

  it('désactiver Tickets signale Scan comme dépendant et les fonctionnalités perdues', () => {
    const p = planDeactivation({ config: { tickets: 'active', scan: 'active', pos: 'active', web: 'active' } }, 'tickets');
    expect(p.dependents).toEqual(['scan']);
    expect(p.lostFeatures.map((f) => f.feature).sort()).toEqual(['pos.ticketSales', 'web.ticketingBlock']);
  });

  it('la mise en lecture seule ne casse pas les dépendants', () => {
    const p = planDeactivation({ config: { tickets: 'active', scan: 'active' } }, 'tickets', 'readonly');
    expect(p.dependents).toEqual([]);
  });

  it('refuse la désactivation des modules de socle', () => {
    expect(planDeactivation({ config: {} }, 'admin').blockers).toHaveLength(1);
  });

  it('les profils ne contiennent que des modules non-socle dont les dépendances sont incluses', () => {
    for (const p of MODULE_PROFILES) {
      const config = Object.fromEntries(p.modules.map((m) => [m, 'active']));
      const r = resolveModules({ config });
      for (const m of p.modules) {
        expect(MODULES_BY_ID[m].core).toBe(false);
        expect(r[m].state, `${p.id}:${m}`).toBe('active');
      }
    }
  });
});

describe('permissions', () => {
  it('gère les jokers', () => {
    expect(grantsCover(['*'], 'asso.members.read')).toBe(true);
    expect(grantsCover(['asso.*'], 'asso.members.read')).toBe(true);
    expect(grantsCover(['asso.*'], 'asso.read')).toBe(true);
    expect(grantsCover(['asso.members.*'], 'asso.members.export')).toBe(true);
    expect(grantsCover(['asso.members.*'], 'asso.read')).toBe(false);
    expect(grantsCover(['asso.members.read'], 'asso.members.update')).toBe(false);
    expect(grantsCover(['assoc.*'], 'asso.read')).toBe(false);
    expect(grantsCover([], 'hub.read')).toBe(false);
  });

  it('valide les permissions accordées', () => {
    expect(isValidGrant('asso.members.read')).toBe(true);
    expect(isValidGrant('asso.*')).toBe(true);
    expect(isValidGrant('*')).toBe(true);
    expect(isValidGrant('asso.members.fly')).toBe(false);
    expect(isValidGrant('nope.*')).toBe(false);
  });

  it('visibilité des modules dans le lanceur', () => {
    expect(canSeeModule(['asso.members.read'], 'asso')).toBe(true);
    expect(canSeeModule(['asso.members.read'], 'finance')).toBe(false);
  });

  it('tous les modèles de rôles référencent des permissions valides', () => {
    expect(ROLE_TEMPLATES.length).toBeGreaterThanOrEqual(19);
    for (const r of ROLE_TEMPLATES) for (const p of r.permissions) expect(isValidGrant(p), `${r.key}:${p}`).toBe(true);
    expect(PERMISSION_KEYS.has('hub.read')).toBe(true);
  });
});
