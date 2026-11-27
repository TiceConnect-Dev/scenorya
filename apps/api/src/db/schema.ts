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

/* ------------------------------------------------------- Scenorya Agenda */

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  description: text('description'),
  location: text('location'),
  category: text('category').notNull().default('other'),
  startAt: ts('start_at').notNull(),
  endAt: ts('end_at').notNull(),
  allDay: boolean('all_day').notNull().default(false),
  /** Règle de récurrence (RecurrenceRule) ou null. */
  rule: jsonb('rule').$type<import('@scenorya/shared').RecurrenceRule | null>(),
  /** Dates locales des occurrences annulées. */
  exdates: text('exdates').array().notNull().default(sql`'{}'::text[]`),
  /** internal | public (publiable sur le site, phase 7) */
  visibility: text('visibility').notNull().default('internal'),
  cancelledAt: ts('cancelled_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('events_assoc_start_idx').on(t.associationId, t.startAt)]);

export const eventParticipants = pgTable('event_participants', {
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  /** invited | yes | no | maybe */
  status: text('status').notNull().default('invited'),
  comment: text('comment'),
  respondedAt: ts('responded_at'),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.eventId, t.memberId] }), index('event_participants_member_idx').on(t.memberId)]);

/** Abonnements iCal personnels (jeton secret, révocable). */
export const calendarFeeds = pgTable('calendar_feeds', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationUserId: uuid('association_user_id').notNull().references(() => associationUsers.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: createdAt(),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
});

/* ----------------------------------------------------- Scenorya Projects */

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  description: text('description'),
  /** Date de référence (ex. première représentation) pour les échéances relatives des modèles. */
  referenceDate: date('reference_date'),
  isTemplate: boolean('is_template').notNull().default(false),
  archivedAt: ts('archived_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('projects_assoc_idx').on(t.associationId)]);

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id'),
  title: text('title').notNull(),
  description: text('description'),
  /** todo | doing | waiting | done */
  status: text('status').notNull().default('todo'),
  /** low | normal | high | urgent */
  priority: text('priority').notNull().default('normal'),
  /** Personne responsable (compte ayant accès à l'association). */
  assigneeId: uuid('assignee_id').references(() => associationUsers.id, { onDelete: 'set null' }),
  dueDate: date('due_date'),
  /** Modèles : échéance en jours par rapport à la date de référence (négatif = avant). */
  dueOffsetDays: integer('due_offset_days'),
  labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
  checklist: jsonb('checklist').$type<{ text: string; done: boolean }[]>().notNull().default([]),
  position: integer('position').notNull().default(0),
  completedAt: ts('completed_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('tasks_project_idx').on(t.projectId, t.status, t.position), index('tasks_assignee_idx').on(t.assigneeId)]);

export const taskComments = pgTable('task_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').references(() => users.id),
  body: text('body').notNull(),
  createdAt: createdAt(),
});

/* ------------------------------------------- Module Asso : gouvernance */

export const meetings = pgTable('meetings', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  /** ag_ordinaire | ag_extraordinaire | ca | bureau | autre */
  type: text('type').notNull(),
  title: text('title').notNull(),
  startAt: ts('start_at').notNull(),
  location: text('location'),
  /** Points de l'ordre du jour. */
  agendaItems: jsonb('agenda_items').$type<{ title: string; description?: string | null; vote: boolean }[]>().notNull().default([]),
  /** Quorum requis en pourcentage des convoqués (null = aucun). */
  quorumPercent: integer('quorum_percent'),
  /** Nombre maximal de procurations par mandataire (null = illimité). */
  maxProxies: integer('max_proxies'),
  /** draft | convened | held | closed */
  status: text('status').notNull().default('draft'),
  convenedAt: ts('convened_at'),
  minutes: text('minutes'),
  /** Événement d'agenda lié (si Scenorya Agenda est actif). */
  eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
  closedAt: ts('closed_at'),
  closedBy: uuid('closed_by').references(() => users.id),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('meetings_assoc_idx').on(t.associationId, t.startAt)]);

export const meetingAttendees = pgTable('meeting_attendees', {
  meetingId: uuid('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'restrict' }),
  /** convened | present | represented | excused | absent */
  status: text('status').notNull().default('convened'),
  /** Mandataire (adhérent présent) en cas de procuration. */
  proxyMemberId: uuid('proxy_member_id').references(() => members.id, { onDelete: 'restrict' }),
  emailStatus: text('email_status'),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.meetingId, t.memberId] })]);

export const resolutions = pgTable('resolutions', {
  id: uuid('id').primaryKey().defaultRandom(),
  meetingId: uuid('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  number: integer('number').notNull(),
  title: text('title').notNull(),
  text: text('text'),
  votesFor: integer('votes_for').notNull().default(0),
  votesAgainst: integer('votes_against').notNull().default(0),
  abstentions: integer('abstentions').notNull().default(0),
  /** adopted | rejected | pending */
  result: text('result').notNull().default('pending'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('resolutions_number_unique').on(t.meetingId, t.number)]);

export const mandates = pgTable('mandates', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'restrict' }),
  /** bureau | ca | autre */
  body: text('body').notNull(),
  role: text('role').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date'),
  meetingId: uuid('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => [index('mandates_assoc_idx').on(t.associationId)]);

/* --------------------------------------------------------- Scenorya Drive */

/** Contenu stocké une seule fois (adressé par empreinte SHA-256) sous DATA_DIR/files. */
export const driveBlobs = pgTable('drive_blobs', {
  sha256: text('sha256').primaryKey(),
  size: bigint('size', { mode: 'number' }).notNull(),
  createdAt: createdAt(),
});

export const driveFolders = pgTable('drive_folders', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  parentId: uuid('parent_id'),
  name: text('name').notNull(),
  /** Dossier restreint : visible uniquement des rôles listés (et des administrateurs de Drive). */
  restricted: boolean('restricted').notNull().default(false),
  /** Publié dans Scenorya Espace : lisible par tous les membres liés à un compte. */
  espace: boolean('espace').notNull().default(false),
  allowedRoleIds: uuid('allowed_role_ids').array().notNull().default(sql`'{}'::uuid[]`),
  deletedAt: ts('deleted_at'),
  /** Lot de suppression : un dossier et son contenu partent et reviennent ensemble. */
  trashBatch: uuid('trash_batch'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('drive_folders_parent_idx').on(t.associationId, t.parentId)]);

export const driveFiles = pgTable('drive_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  folderId: uuid('folder_id').references(() => driveFolders.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  description: text('description'),
  mime: text('mime').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull().references(() => driveBlobs.sha256),
  version: integer('version').notNull().default(1),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  deletedAt: ts('deleted_at'),
  trashBatch: uuid('trash_batch'),
  deletedBy: uuid('deleted_by').references(() => users.id),
  createdBy: uuid('created_by').references(() => users.id),
  updatedBy: uuid('updated_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('drive_files_folder_idx').on(t.associationId, t.folderId), index('drive_files_sha_idx').on(t.sha256)]);

export const driveFileVersions = pgTable('drive_file_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  fileId: uuid('file_id').notNull().references(() => driveFiles.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  sha256: text('sha256').notNull().references(() => driveBlobs.sha256),
  size: bigint('size', { mode: 'number' }).notNull(),
  mime: text('mime').notNull(),
  originalName: text('original_name').notNull(),
  comment: text('comment'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('drive_versions_unique').on(t.fileId, t.version), index('drive_versions_sha_idx').on(t.sha256)]);

export const driveFavorites = pgTable('drive_favorites', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  fileId: uuid('file_id').notNull().references(() => driveFiles.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.userId, t.fileId] })]);

export const driveShares = pgTable('drive_shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  fileId: uuid('file_id').notNull().references(() => driveFiles.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  passwordHash: text('password_hash'),
  expiresAt: ts('expires_at').notNull(),
  maxDownloads: integer('max_downloads'),
  downloadCount: integer('download_count').notNull().default(0),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: ts('locked_until'),
  revokedAt: ts('revoked_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
}, (t) => [index('drive_shares_file_idx').on(t.fileId)]);

/** Journal des accès aux fichiers (téléchargements, aperçus, liens publics). */
export const driveAccessLog = pgTable('drive_access_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  fileId: uuid('file_id').references(() => driveFiles.id, { onDelete: 'set null' }),
  fileName: text('file_name').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  shareId: uuid('share_id').references(() => driveShares.id, { onDelete: 'set null' }),
  /** download | preview | share_download | share_denied */
  action: text('action').notNull(),
  version: integer('version'),
  ip: text('ip'),
  createdAt: createdAt(),
}, (t) => [index('drive_access_assoc_idx').on(t.associationId, t.createdAt)]);

/** Fichier rattaché à un élément d'un autre module (ex. pièce jointe d'une tâche). */
export const driveLinks = pgTable('drive_links', {
  fileId: uuid('file_id').notNull().references(() => driveFiles.id, { onDelete: 'cascade' }),
  module: text('module').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.fileId, t.module, t.entityType, t.entityId] }), index('drive_links_entity_idx').on(t.module, t.entityType, t.entityId)]);

/** Paramètres Drive par association (quota fixé par le superadministrateur). */
export const driveSettings = pgTable('drive_settings', {
  associationId: uuid('association_id').primaryKey().references(() => associations.id, { onDelete: 'cascade' }),
  quotaBytes: bigint('quota_bytes', { mode: 'number' }),
  updatedAt: updatedAt(),
});

/* --------------------------------------------------------- Scenorya Espace */

/** Invitation d'un adhérent à créer (ou relier) son compte pour accéder à son espace personnel. */
export const memberInvitations = pgTable('member_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  acceptedAt: ts('accepted_at'),
  revokedAt: ts('revoked_at'),
  /** sent | failed: … | not_sent */
  emailStatus: text('email_status'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
}, (t) => [index('member_invitations_member_idx').on(t.memberId)]);

/* --------------------------------------------------------- Scenorya Cast */

/** Production (pièce, spectacle) en cours de distribution et de répétition. */
export const castProductions = pgTable('cast_productions', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  author: text('author'),
  description: text('description'),
  season: text('season'),
  /** preparation | rehearsal | running | closed */
  status: text('status').notNull().default('preparation'),
  premiereDate: date('premiere_date'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('cast_productions_assoc_idx').on(t.associationId)]);

/** Personnage ou emploi d'une production. */
export const castRoles = pgTable('cast_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  productionId: uuid('production_id').notNull().references(() => castProductions.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  /** main | secondary | ensemble */
  category: text('category').notNull().default('main'),
  position: integer('position').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index('cast_roles_prod_idx').on(t.productionId)]);

/** Distribution : un adhérent tient un rôle (titulaire) ou le double (doublure). */
export const castAssignments = pgTable('cast_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  roleId: uuid('role_id').notNull().references(() => castRoles.id, { onDelete: 'cascade' }),
  memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  /** lead | understudy */
  kind: text('kind').notNull().default('lead'),
  /** considered | confirmed */
  status: text('status').notNull().default('confirmed'),
  note: text('note'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('cast_assignments_unique').on(t.roleId, t.memberId), index('cast_assignments_member_idx').on(t.memberId)]);

export const castScenes = pgTable('cast_scenes', {
  id: uuid('id').primaryKey().defaultRandom(),
  productionId: uuid('production_id').notNull().references(() => castProductions.id, { onDelete: 'cascade' }),
  act: integer('act'),
  number: integer('number'),
  title: text('title').notNull(),
  durationMin: integer('duration_min'),
  position: integer('position').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index('cast_scenes_prod_idx').on(t.productionId)]);

/** Présence des personnages dans les scènes. */
export const castSceneRoles = pgTable('cast_scene_roles', {
  sceneId: uuid('scene_id').notNull().references(() => castScenes.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => castRoles.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.sceneId, t.roleId] })]);

/** Indisponibilités déclarées par (ou pour) un adhérent. */
export const castUnavailabilities = pgTable('cast_unavailabilities', {
  id: uuid('id').primaryKey().defaultRandom(),
  associationId: uuid('association_id').notNull().references(() => associations.id, { onDelete: 'restrict' }),
  memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  reason: text('reason'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
}, (t) => [index('cast_unav_member_idx').on(t.memberId, t.startsOn)]);

/** Répétition : scènes travaillées ; les convoqués se déduisent de la distribution. */
export const castRehearsals = pgTable('cast_rehearsals', {
  id: uuid('id').primaryKey().defaultRandom(),
  productionId: uuid('production_id').notNull().references(() => castProductions.id, { onDelete: 'cascade' }),
  title: text('title'),
  startAt: ts('start_at').notNull(),
  endAt: ts('end_at').notNull(),
  location: text('location'),
  /** Scènes travaillées ; vide = filage (toute la pièce). */
  sceneIds: uuid('scene_ids').array().notNull().default(sql`'{}'::uuid[]`),
  includeUnderstudies: boolean('include_understudies').notNull().default(false),
  notes: text('notes'),
  /** Événement d'agenda synchronisé (fonctionnalité cast.agendaCalls). */
  eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('cast_rehearsals_prod_idx').on(t.productionId, t.startAt)]);
