import type { ModuleId, ResolvedModules, ResolvedModule } from '@scenorya/shared';

export interface User {
  id: string;
  email: string;
  displayName: string;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
}

export interface Me {
  user: User;
  csrfToken: string;
  associations: { id: string; name: string; slug: string; primaryColor: string }[];
  instance: { version: string; edition: string; modules: number };
}

export interface AppContext {
  association: { id: string; name: string };
  grants: string[];
  modules: ResolvedModules;
  visibleModules: ModuleId[];
  isSuperAdmin: boolean;
}

export interface CatalogueItem {
  id: ModuleId;
  resolved: ResolvedModule;
  instanceEnabled: boolean;
  activatedAt: string | null;
  deactivatedAt: string | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Member {
  id: string;
  number: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  birthDate: string | null;
  addressLine: string | null;
  postalCode: string | null;
  city: string | null;
  category: string;
  status: string;
  joinedAt: string;
  isMinor: boolean;
  guardianName: string | null;
  guardianPhone: string | null;
  guardianEmail: string | null;
  imageRights: boolean;
  skills: string[];
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sensitiveHidden: boolean;
}

export interface AuditEntry {
  id: number;
  action: string;
  summary: string;
  actorLabel: string | null;
  createdAt: string;
  resourceType?: string | null;
  resourceId?: string | null;
  ip?: string | null;
  hash?: string;
  data?: Record<string, unknown>;
}
