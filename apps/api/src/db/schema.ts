import { sql } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, date, index, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();

/* ------------------------------------------------------------------ Socle */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  isSuperAdmin: boolean('is_super_admin').notNull().default(false),
  status: text('status').notNull().default('active'), // active | disabled
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  lastLoginAt: ts('last_login_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('users_email_unique').on(sql`lower(${t.email})`)]);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  csrfToken: text('csrf_token').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
}, (t) => [index('sessions_user_idx').on(t.userId)]);

export const loginAttempts = pgTable('login_attempts', {
  id: serial('id').primaryKey(),
  key: text('key').notNull(),
  success: boolean('success').notNull(),
  createdAt: createdAt(),
}, (t) => [index('login_attempts_key_idx').on(t.key, t.createdAt)]);

export const associations = pgTable('associations', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  shortName: text('short_name'),
  legalName: text('legal_name'),
  rna: text('rna'),
  siret: text('siret'),
  email: text('email'),
  phone: text('phone'),
  website: text('website'),
  addressLine: text('address_line'),
  postalCode: text('postal_code'),
  city: text('city'),
  country: text('country').notNull().default('France'),
  primaryColor: text('primary_color').notNull().default('#1765AD'),
  fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(1),
  insurance: text('insurance'),
  /** IBAN chiffré (AES-256-GCM) — donnée sensible. */
  ibanEncrypted: text('iban_encrypted'),
  bic: text('bic'),
  status: text('status').notNull().default('active'), // active | archived
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const associationUsers = pgTable('association_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  status: text('status').notNull().default('active'), // active | disabled
  /** Accès temporaire : au-delà de cette date l'accès est refusé. */
  expiresAt: ts('expires_at'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('association_users_unique').on(t.associationId, t.userId)]);

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  key: text('key'),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('roles_name_unique').on(t.associationId, t.name)]);

export const roleAssignments = pgTable('role_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationUserId: uuid('association_user_id').notNull().references(() => associationUsers.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'restrict' }),
  /** Portée facultative : ex. scope_type = 'show', scope_id = <id du spectacle>. */
  scopeType: text('scope_type'),
  scopeId: text('scope_id'),
  expiresAt: ts('expires_at'),
  createdAt: createdAt(),
}, (t) => [index('role_assignments_au_idx').on(t.associationUserId)]);

/* --------------------------------------------------------------- Modules */

export const instanceModules = pgTable('instance_modules', {
  moduleId: text('module_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  updatedAt: updatedAt(),
  updatedBy: uuid('updated_by').references(() => users.id),
});

export const associationModules = pgTable('association_modules', {
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  moduleId: text('module_id').notNull(),
  state: text('state').notNull(), // active | readonly | inactive
  settings: jsonb('settings').notNull().default({}),
  activatedAt: ts('activated_at'),
  deactivatedAt: ts('deactivated_at'),
  updatedAt: updatedAt(),
  updatedBy: uuid('updated_by').references(() => users.id),
}, (t) => [primaryKey({ columns: [t.associationId, t.moduleId] })]);

export const moduleConfigHistory = pgTable('module_config_history', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  associationId: uuid('association_id').references(() => associations.id),
  moduleId: text('module_id').notNull(),
  oldState: text('old_state'),
  newState: text('new_state').notNull(),
  actorId: uuid('actor_id').references(() => users.id),
  reason: text('reason'),
  createdAt: createdAt(),
}, (t) => [index('module_history_assoc_idx').on(t.associationId, t.createdAt)]);

/* ----------------------------------------------------------------- Audit */

export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  associationId: uuid('association_id').references(() => associations.id),
  actorId: uuid('actor_id').references(() => users.id),
  actorLabel: text('actor_label'),
  action: text('action').notNull(),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  summary: text('summary').notNull(),
  data: jsonb('data').notNull().default({}),
  ip: text('ip'),
  createdAt: createdAt(),
  prevHash: text('prev_hash'),
  hash: text('hash').notNull(),
}, (t) => [index('audit_assoc_idx').on(t.associationId, t.id)]);

/* -------------------------------------------------------------- Système */

export const instanceSettings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});

export const backups = pgTable('backups', {
  id: uuid('id').primaryKey().defaultRandom(),
  filename: text('filename').notNull().unique(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  sha256: text('sha256'),
  status: text('status').notNull(), // running | success | failed
  error: text('error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
});

export const counters = pgTable('counters', {
  associationId: uuid('association_id').notNull().references(() => associations.id),
  key: text('key').notNull(),
  value: integer('value').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.associationId, t.key] })]);

/* ------------------------------------------------- Module Asso : adhérents */

export const members = pgTable('members', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  number: integer('number').notNull(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  email: text('email'),
  phone: text('phone'),
  birthDate: date('birth_date'),
  addressLine: text('address_line'),
  postalCode: text('postal_code'),
  city: text('city'),
  category: text('category').notNull().default('actif'),
  status: text('status').notNull().default('active'), // pending | active | expired | archived
  joinedAt: date('joined_at').notNull().defaultNow(),
  isMinor: boolean('is_minor').notNull().default(false),
  guardianName: text('guardian_name'),
  guardianPhone: text('guardian_phone'),
  guardianEmail: text('guardian_email'),
  imageRights: boolean('image_rights').notNull().default(false),
  skills: text('skills').array().notNull().default(sql`'{}'::text[]`),
  notes: text('notes'),
  /** Valeurs des champs personnalisés définis par l'association (member_field_defs). */
  custom: jsonb('custom').notNull().default({}),
  /** Jeton opaque de la carte d'adhérent (QR) : aucune donnée personnelle. */
  cardToken: text('card_token'),
  userId: uuid('user_id').references(() => users.id),
  archivedAt: ts('archived_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('members_number_unique').on(t.associationId, t.number),
  uniqueIndex('members_card_token_unique').on(t.cardToken),
  index('members_assoc_name_idx').on(t.associationId, t.lastName),
]);

/* ---------------------------------------------- Module Asso : cotisations */

/** Formules de cotisation. Montants en centimes (entiers), jamais en flottants. */
export const membershipPlans = pgTable('membership_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  description: text('description'),
  amountCents: integer('amount_cents').notNull(),
  /** calendar_year | fiscal_year | rolling_12m | one_time */
  periodType: text('period_type').notNull(),
  /** Catégorie d'adhérent attribuée à la validation (facultatif). */
  memberCategory: text('member_category'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('membership_plans_name_unique').on(t.associationId, t.name)]);

export const membershipDues = pgTable('membership_dues', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'restrict' }),
  planId: uuid('plan_id').references(() => membershipPlans.id, { onDelete: 'restrict' }),
  label: text('label').notNull(),
  amountCents: integer('amount_cents').notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end'),
  /** due | partial | paid | waived | cancelled */
  status: text('status').notNull().default('due'),
  receiptNumber: text('receipt_number'),
  receiptIssuedAt: ts('receipt_issued_at'),
  receiptCancelledAt: ts('receipt_cancelled_at'),
  cancelReason: text('cancel_reason'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('membership_dues_member_idx').on(t.associationId, t.memberId),
  uniqueIndex('membership_dues_receipt_unique').on(t.associationId, t.receiptNumber),
]);

/** Règlements : jamais modifiés ni supprimés, seulement annulés (traçabilité). */
export const membershipPayments = pgTable('membership_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  dueId: uuid('due_id').notNull().references(() => membershipDues.id, { onDelete: 'restrict' }),
  amountCents: integer('amount_cents').notNull(),
  /** cash | cheque | transfer | card | online | other */
  method: text('method').notNull(),
  paidAt: date('paid_at').notNull(),
  reference: text('reference'),
  recordedBy: uuid('recorded_by').references(() => users.id),
  createdAt: createdAt(),
  cancelledAt: ts('cancelled_at'),
  cancelledBy: uuid('cancelled_by').references(() => users.id),
  cancelReason: text('cancel_reason'),
}, (t) => [index('membership_payments_due_idx').on(t.dueId)]);

/* ------------------------------------- Module Asso : groupes et champs */

export const memberGroups = pgTable('member_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  /** group | commission | troupe | bureau */
  kind: text('kind').notNull().default('group'),
  description: text('description'),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('member_groups_name_unique').on(t.associationId, t.name)]);

export const memberGroupLinks = pgTable('member_group_links', {
  groupId: uuid('group_id').notNull().references(() => memberGroups.id, { onDelete: 'cascade' }),
  memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  /** Fonction dans le groupe (président de commission, référent…). */
  role: text('role'),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.groupId, t.memberId] }), index('member_group_links_member_idx').on(t.memberId)]);

/** Définition des champs personnalisés des fiches adhérent. */
export const memberFieldDefs = pgTable('member_field_defs', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  key: text('key').notNull(),
  label: text('label').notNull(),
  /** text | number | date | boolean | select */
  type: text('type').notNull(),
  options: text('options').array().notNull().default(sql`'{}'::text[]`),
  required: boolean('required').notNull().default(false),
  /** Visible seulement avec asso.members.sensitive. */
  sensitive: boolean('sensitive').notNull().default(false),
  position: integer('position').notNull().default(0),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('member_field_defs_key_unique').on(t.associationId, t.key)]);
