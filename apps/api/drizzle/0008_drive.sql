CREATE TABLE "drive_access_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"association_id" uuid NOT NULL,
	"file_id" uuid,
	"file_name" text NOT NULL,
	"user_id" uuid,
	"share_id" uuid,
	"action" text NOT NULL,
	"version" integer,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_blobs" (
	"sha256" text PRIMARY KEY NOT NULL,
	"size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_favorites" (
	"user_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_favorites_user_id_file_id_pk" PRIMARY KEY("user_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "drive_file_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"mime" text NOT NULL,
	"original_name" text NOT NULL,
	"comment" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"folder_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"deleted_at" timestamp with time zone,
	"trash_batch" uuid,
	"deleted_by" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"restricted" boolean DEFAULT false NOT NULL,
	"allowed_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"deleted_at" timestamp with time zone,
	"trash_batch" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_links" (
	"file_id" uuid NOT NULL,
	"module" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_links_file_id_module_entity_type_entity_id_pk" PRIMARY KEY("file_id","module","entity_type","entity_id")
);
--> statement-breakpoint
CREATE TABLE "drive_settings" (
	"association_id" uuid PRIMARY KEY NOT NULL,
	"quota_bytes" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"max_downloads" integer,
	"download_count" integer DEFAULT 0 NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_shares_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "drive_access_log" ADD CONSTRAINT "drive_access_log_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_access_log" ADD CONSTRAINT "drive_access_log_file_id_drive_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."drive_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_access_log" ADD CONSTRAINT "drive_access_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_access_log" ADD CONSTRAINT "drive_access_log_share_id_drive_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."drive_shares"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_favorites" ADD CONSTRAINT "drive_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_favorites" ADD CONSTRAINT "drive_favorites_file_id_drive_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."drive_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_file_versions" ADD CONSTRAINT "drive_file_versions_file_id_drive_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."drive_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_file_versions" ADD CONSTRAINT "drive_file_versions_sha256_drive_blobs_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."drive_blobs"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_file_versions" ADD CONSTRAINT "drive_file_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_folder_id_drive_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."drive_folders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_sha256_drive_blobs_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."drive_blobs"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_folders" ADD CONSTRAINT "drive_folders_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_folders" ADD CONSTRAINT "drive_folders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_links" ADD CONSTRAINT "drive_links_file_id_drive_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."drive_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_links" ADD CONSTRAINT "drive_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_settings" ADD CONSTRAINT "drive_settings_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_shares" ADD CONSTRAINT "drive_shares_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_shares" ADD CONSTRAINT "drive_shares_file_id_drive_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."drive_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_shares" ADD CONSTRAINT "drive_shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_access_assoc_idx" ON "drive_access_log" USING btree ("association_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_versions_unique" ON "drive_file_versions" USING btree ("file_id","version");--> statement-breakpoint
CREATE INDEX "drive_versions_sha_idx" ON "drive_file_versions" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "drive_files_folder_idx" ON "drive_files" USING btree ("association_id","folder_id");--> statement-breakpoint
CREATE INDEX "drive_files_sha_idx" ON "drive_files" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "drive_folders_parent_idx" ON "drive_folders" USING btree ("association_id","parent_id");--> statement-breakpoint
CREATE INDEX "drive_links_entity_idx" ON "drive_links" USING btree ("module","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "drive_shares_file_idx" ON "drive_shares" USING btree ("file_id");--> statement-breakpoint
ALTER TABLE "drive_folders" ADD CONSTRAINT "drive_folders_name_chk" CHECK (length(btrim("name")) BETWEEN 1 AND 200 AND "name" !~ '[/\\]');--> statement-breakpoint
ALTER TABLE "drive_folders" ADD CONSTRAINT "drive_folders_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "drive_folders"("id");--> statement-breakpoint
ALTER TABLE "drive_folders" ADD CONSTRAINT "drive_folders_not_self_chk" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_name_chk" CHECK (length(btrim("name")) BETWEEN 1 AND 255 AND "name" !~ '[/\\]');--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_size_chk" CHECK ("size" >= 0);--> statement-breakpoint
ALTER TABLE "drive_shares" ADD CONSTRAINT "drive_shares_max_chk" CHECK ("max_downloads" IS NULL OR "max_downloads" > 0);--> statement-breakpoint
CREATE UNIQUE INDEX "drive_folders_name_unique" ON "drive_folders" ("association_id", coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid), lower("name")) WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "drive_files_name_unique" ON "drive_files" ("association_id", coalesce("folder_id", '00000000-0000-0000-0000-000000000000'::uuid), lower("name")) WHERE "deleted_at" IS NULL;
