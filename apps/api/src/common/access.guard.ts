import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { grantsCover, MODULES_BY_ID } from '@scenorya/shared';
import { ACCESS_KEY, ASSOCIATION_HEADER, AccessRule, CSRF_HEADER, SESSION_COOKIE, ScenoryaRequest } from './access';
import { Forbidden, Unauthorized } from './errors';
import { safeEqual } from './crypto';
import { SessionService } from '../auth/session.service';
import { PermissionService } from '../admin/permission.service';
import { ModulesService } from '../modules/modules.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Garde globale, refus par défaut :
 *  1. toute route doit déclarer une règle d'accès, sinon 403 ;
 *  2. session valide (cookie httpOnly) + jeton CSRF pour toute méthode non sûre ;
 *  3. pour les routes d'association : appartenance active et non expirée,
 *     module utilisable (écriture refusée en lecture seule), permission accordée.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly permissions: PermissionService,
    private readonly modules: ModulesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_KEY, [context.getHandler(), context.getClass()]);
    const req = context.switchToHttp().getRequest<ScenoryaRequest>();
    req.ctx = {};
    if (!rule) throw Forbidden('ACCESS_NOT_DECLARED', 'Accès refusé.');

    const auth = await this.sessions.resolve(req.cookies?.[SESSION_COOKIE]);
    if (auth) {
      req.ctx.user = auth.user;
      req.ctx.session = auth.session;
    }
    if (rule.kind === 'public') return true;
    if (!auth) throw Unauthorized();

    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers[CSRF_HEADER];
      if (typeof header !== 'string' || !safeEqual(header, auth.session.csrfToken)) {
        throw Forbidden('CSRF_INVALID', 'Jeton de sécurité invalide. Rechargez la page.');
      }
    }

    if (auth.user.mustChangePassword && !(rule.kind === 'authenticated' && rule.allowPasswordChange)) {
      throw Forbidden('PASSWORD_CHANGE_REQUIRED', 'Vous devez changer votre mot de passe.');
    }
    if (rule.kind === 'authenticated') return true;
    if (rule.kind === 'superadmin') {
      if (!auth.user.isSuperAdmin) throw Forbidden('SUPERADMIN_REQUIRED', 'Réservé aux superadministrateurs.');
      return true;
    }

    // Route d'association
    // Les liens ouverts directement par le navigateur (aperçu d'un document, image) ne peuvent pas
    // porter d'en-tête : pour les seules lectures, l'association peut être indiquée par `?assoc=`.
    // L'appartenance et les permissions restent vérifiées ci-dessous.
    const fromQuery = req.method === 'GET' && typeof req.query?.assoc === 'string' ? req.query.assoc : undefined;
    const associationId = req.headers[ASSOCIATION_HEADER] ?? fromQuery;
    if (typeof associationId !== 'string' || !UUID_RE.test(associationId)) {
      throw Forbidden('ASSOCIATION_REQUIRED', 'Association non précisée.');
    }
    const membership = await this.permissions.membership(auth.user.id, associationId);
    if (!membership) throw Forbidden('NOT_MEMBER', "Vous n'avez pas accès à cette association.");

    const resolved = await this.modules.resolved(associationId);
    const grants = await this.permissions.grants(membership.id);
    req.ctx.association = membership.association;
    req.ctx.membershipId = membership.id;
    req.ctx.grants = grants;
    req.ctx.modules = resolved;
    if (rule.kind === 'member') return true;

    const mod = resolved[rule.module];
    if (!mod.usable) {
      throw Forbidden('MODULE_DISABLED', `${MODULES_BY_ID[rule.module].name} n'est pas disponible pour cette association.`, {
        module: rule.module,
        state: mod.state,
        missing: mod.missing,
      });
    }
    const isWrite = rule.write ?? !SAFE_METHODS.has(req.method);
    if (isWrite && !mod.writable) {
      throw Forbidden('MODULE_READONLY', `${MODULES_BY_ID[rule.module].name} est en lecture seule (clôture).`, { module: rule.module });
    }
    if (!grantsCover(grants, rule.permission)) {
      throw Forbidden('PERMISSION_DENIED', 'Vous ne disposez pas des droits nécessaires.', { permission: rule.permission });
    }
    return true;
  }
}
