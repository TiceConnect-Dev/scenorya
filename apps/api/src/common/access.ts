import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { ModuleId, ResolvedModules } from '@scenorya/shared';
import type { Request } from 'express';

export const ACCESS_KEY = 'scenorya:access';

export type AccessRule =
  | { kind: 'public' }
  | { kind: 'authenticated'; allowPasswordChange?: boolean }
  | { kind: 'superadmin' }
  /** Appartenance active à l'association, sans permission particulière (contexte, préférences). */
  | { kind: 'member' }
  | {
      kind: 'association';
      module: ModuleId;
      /** Permission requise (`<module>.<ressource>.<action>`), vérifiée côté serveur. */
      permission: string;
      /** Écriture : refusée si le module est en lecture seule. Par défaut : méthode ≠ GET. */
      write?: boolean;
    };

/** Route accessible sans authentification. */
export const Public = () => SetMetadata(ACCESS_KEY, { kind: 'public' } satisfies AccessRule);
/** Route accessible à tout utilisateur connecté (hors contexte d'association). */
export const Authenticated = (opts: { allowPasswordChange?: boolean } = {}) =>
  SetMetadata(ACCESS_KEY, { kind: 'authenticated', ...opts } satisfies AccessRule);
/** Route réservée aux superadministrateurs de l'instance. */
export const SuperAdminOnly = () => SetMetadata(ACCESS_KEY, { kind: 'superadmin' } satisfies AccessRule);
/** Route d'association ne nécessitant que l'appartenance (ex. chargement du contexte). */
export const MemberOnly = () => SetMetadata(ACCESS_KEY, { kind: 'member' } satisfies AccessRule);
/** Route d'association : appartenance + module utilisable + permission. */
export const Access = (module: ModuleId, permission: string, opts: { write?: boolean } = {}) =>
  SetMetadata(ACCESS_KEY, { kind: 'association', module, permission, ...opts } satisfies AccessRule);

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
}

export interface RequestContext {
  user?: AuthUser;
  session?: { id: string; csrfToken: string };
  association?: { id: string; name: string };
  membershipId?: string;
  grants?: string[];
  modules?: ResolvedModules;
}

export type ScenoryaRequest = Request & { ctx: RequestContext };

export const Ctx = createParamDecorator((_: unknown, host: ExecutionContext): RequestContext => {
  const req = host.switchToHttp().getRequest<ScenoryaRequest>();
  return req.ctx ?? {};
});

/** Contexte d'association garanti (routes @Access). */
export interface AssocCtx {
  user: AuthUser;
  association: { id: string; name: string };
  membershipId: string;
  grants: string[];
  modules: ResolvedModules;
  ip: string | null;
}

export const AssocContext = createParamDecorator((_: unknown, host: ExecutionContext): AssocCtx => {
  const req = host.switchToHttp().getRequest<ScenoryaRequest>();
  const c = req.ctx;
  if (!c?.user || !c.association || !c.membershipId || !c.grants || !c.modules) {
    throw new Error('AssocContext utilisé sur une route sans règle @Access ou @MemberOnly');
  }
  return { user: c.user, association: c.association, membershipId: c.membershipId, grants: c.grants, modules: c.modules, ip: req.ip ?? null };
});

export const ASSOCIATION_HEADER = 'x-scenorya-association';
export const CSRF_HEADER = 'x-csrf-token';
export const SESSION_COOKIE = 'scn_session';
