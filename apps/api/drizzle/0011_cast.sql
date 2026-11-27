CREATE TABLE "cast_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" text DEFAULT 'lead' NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cast_productions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"description" text,
	"season" text,
	"status" text DEFAULT 'preparation' NOT NULL,
	"premiere_date" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cast_rehearsals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_id" uuid NOT NULL,
	"title" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"location" text,
	"scene_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"include_understudies" boolean DEFAULT false NOT NULL,
	"notes" text,
	"event_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cast_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'main' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cast_scene_roles" (
	"scene_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "cast_scene_roles_scene_id_role_id_pk" PRIMARY KEY("scene_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "cast_scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_id" uuid NOT NULL,
	"act" integer,
	"number" integer,
	"title" text NOT NULL,
	"duration_min" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cast_unavailabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cast_assignments" ADD CONSTRAINT "cast_assignments_role_id_cast_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."cast_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cast_assignments" ADD CONSTRAINT "cast_assignments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cast_productions" ADD CONSTRAINT "cast_productions_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cast_productions" ADD CONSTRAINT "cast_productions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cast_rehearsals" ADD CONSTRAINT "cast_rehearsals_production_id_cast_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."cast_productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cast_rehearsals" ADD CONSTRAINT "cast_rehearsals_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cast_rehearsals" ADD CONSTRAINT "cast_rehearsals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cast_roles" ADD CONSTRAINT "cast_roles_production_id_cast_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."cast_productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cast_scene_roles" ADD CONSTRAINT "cast_scene_roles_scene_id_cast_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."cast_scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cast_scene_roles" ADD CONSTRAINT "cast_scene_roles_role_id_cast_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."cast_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cast_scenes" ADD CONSTRAINT "cast_scenes_production_id_cast_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."cast_productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cast_unavailabilities" ADD CONSTRAINT "cast_unavailabilities_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cast_unavailabilities" ADD CONSTRAINT "cast_unavailabilities_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cast_unavailabilities" ADD CONSTRAINT "cast_unavailabilities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cast_assignments_unique" ON "cast_assignments" USING btree ("role_id","member_id");--> statement-breakpoint
CREATE INDEX "cast_assignments_member_idx" ON "cast_assignments" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "cast_productions_assoc_idx" ON "cast_productions" USING btree ("association_id");--> statement-breakpoint
CREATE INDEX "cast_rehearsals_prod_idx" ON "cast_rehearsals" USING btree ("production_id","start_at");--> statement-breakpoint
CREATE INDEX "cast_roles_prod_idx" ON "cast_roles" USING btree ("production_id");--> statement-breakpoint
CREATE INDEX "cast_scenes_prod_idx" ON "cast_scenes" USING btree ("production_id");--> statement-breakpoint
CREATE INDEX "cast_unav_member_idx" ON "cast_unavailabilities" USING btree ("member_id","starts_on");--> statement-breakpoint
ALTER TABLE "cast_productions" ADD CONSTRAINT "cast_productions_status_chk" CHECK ("status" IN ('preparation', 'rehearsal', 'running', 'closed'));--> statement-breakpoint
ALTER TABLE "cast_roles" ADD CONSTRAINT "cast_roles_category_chk" CHECK ("category" IN ('main', 'secondary', 'ensemble'));--> statement-breakpoint
ALTER TABLE "cast_assignments" ADD CONSTRAINT "cast_assignments_kind_chk" CHECK ("kind" IN ('lead', 'understudy') AND "status" IN ('considered', 'confirmed'));--> statement-breakpoint
ALTER TABLE "cast_unavailabilities" ADD CONSTRAINT "cast_unav_dates_chk" CHECK ("ends_on" >= "starts_on");--> statement-breakpoint
ALTER TABLE "cast_rehearsals" ADD CONSTRAINT "cast_rehearsals_dates_chk" CHECK ("end_at" > "start_at");
