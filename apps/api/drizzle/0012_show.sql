CREATE TABLE "show_crew" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"job" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "show_performances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" uuid NOT NULL,
	"venue_id" uuid,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"doors_at" timestamp with time zone,
	"capacity" integer,
	"status" text DEFAULT 'planned' NOT NULL,
	"notes" text,
	"event_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "show_venues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address_line" text,
	"postal_code" text,
	"city" text,
	"capacity" integer,
	"accessibility" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"author" text,
	"director" text,
	"genre" text,
	"duration_min" integer,
	"intermission_min" integer,
	"age_min" integer,
	"synopsis" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cast_productions" ADD COLUMN "show_id" uuid;--> statement-breakpoint
ALTER TABLE "show_crew" ADD CONSTRAINT "show_crew_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_crew" ADD CONSTRAINT "show_crew_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_performances" ADD CONSTRAINT "show_performances_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_performances" ADD CONSTRAINT "show_performances_venue_id_show_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."show_venues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_performances" ADD CONSTRAINT "show_performances_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_performances" ADD CONSTRAINT "show_performances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_venues" ADD CONSTRAINT "show_venues_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shows" ADD CONSTRAINT "shows_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shows" ADD CONSTRAINT "shows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "show_crew_unique" ON "show_crew" USING btree ("show_id","member_id","job");--> statement-breakpoint
CREATE INDEX "show_crew_member_idx" ON "show_crew" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "show_perf_show_idx" ON "show_performances" USING btree ("show_id","start_at");--> statement-breakpoint
CREATE INDEX "show_venues_assoc_idx" ON "show_venues" USING btree ("association_id");--> statement-breakpoint
CREATE INDEX "shows_assoc_idx" ON "shows" USING btree ("association_id");--> statement-breakpoint
ALTER TABLE "cast_productions" ADD CONSTRAINT "cast_productions_show_fk" FOREIGN KEY ("show_id") REFERENCES "shows"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "shows" ADD CONSTRAINT "shows_status_chk" CHECK ("status" IN ('draft', 'announced', 'running', 'archived'));--> statement-breakpoint
ALTER TABLE "show_performances" ADD CONSTRAINT "show_perf_status_chk" CHECK ("status" IN ('planned', 'confirmed', 'cancelled', 'done'));--> statement-breakpoint
ALTER TABLE "show_performances" ADD CONSTRAINT "show_perf_dates_chk" CHECK ("end_at" > "start_at" AND ("doors_at" IS NULL OR "doors_at" <= "start_at"));--> statement-breakpoint
ALTER TABLE "show_venues" ADD CONSTRAINT "show_venues_capacity_chk" CHECK ("capacity" IS NULL OR "capacity" >= 0);
