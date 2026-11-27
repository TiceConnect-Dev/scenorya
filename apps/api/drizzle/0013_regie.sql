CREATE TABLE "regie_cues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cuesheet_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"number" text,
	"department" text DEFAULT 'light' NOT NULL,
	"label" text NOT NULL,
	"trigger" text,
	"page" text,
	"duration_sec" integer,
	"notes" text,
	"sound_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regie_cuesheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"title" text NOT NULL,
	"show_id" uuid,
	"notes" text,
	"locked" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regie_run_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"cue_id" uuid,
	"cue_label" text,
	"note" text,
	"at" timestamp with time zone NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regie_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cuesheet_id" uuid NOT NULL,
	"mode" text DEFAULT 'rehearsal' NOT NULL,
	"performance_id" uuid,
	"current_cue_id" uuid,
	"standby_cue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"report" text,
	"started_by" uuid
);
--> statement-breakpoint
CREATE TABLE "regie_sounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cuesheet_id" uuid NOT NULL,
	"drive_file_id" uuid,
	"label" text NOT NULL,
	"hotkey" text,
	"volume" integer DEFAULT 100 NOT NULL,
	"loop" boolean DEFAULT false NOT NULL,
	"fade_in_ms" integer DEFAULT 0 NOT NULL,
	"fade_out_ms" integer DEFAULT 0 NOT NULL,
	"color" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "regie_cues" ADD CONSTRAINT "regie_cues_cuesheet_id_regie_cuesheets_id_fk" FOREIGN KEY ("cuesheet_id") REFERENCES "public"."regie_cuesheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regie_cuesheets" ADD CONSTRAINT "regie_cuesheets_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regie_cuesheets" ADD CONSTRAINT "regie_cuesheets_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regie_cuesheets" ADD CONSTRAINT "regie_cuesheets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regie_run_log" ADD CONSTRAINT "regie_run_log_run_id_regie_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."regie_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regie_run_log" ADD CONSTRAINT "regie_run_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regie_runs" ADD CONSTRAINT "regie_runs_cuesheet_id_regie_cuesheets_id_fk" FOREIGN KEY ("cuesheet_id") REFERENCES "public"."regie_cuesheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regie_runs" ADD CONSTRAINT "regie_runs_performance_id_show_performances_id_fk" FOREIGN KEY ("performance_id") REFERENCES "public"."show_performances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regie_runs" ADD CONSTRAINT "regie_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regie_sounds" ADD CONSTRAINT "regie_sounds_cuesheet_id_regie_cuesheets_id_fk" FOREIGN KEY ("cuesheet_id") REFERENCES "public"."regie_cuesheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regie_sounds" ADD CONSTRAINT "regie_sounds_drive_file_id_drive_files_id_fk" FOREIGN KEY ("drive_file_id") REFERENCES "public"."drive_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "regie_cues_sheet_idx" ON "regie_cues" USING btree ("cuesheet_id","position");--> statement-breakpoint
CREATE INDEX "regie_cuesheets_assoc_idx" ON "regie_cuesheets" USING btree ("association_id");--> statement-breakpoint
CREATE INDEX "regie_run_log_run_idx" ON "regie_run_log" USING btree ("run_id","at");--> statement-breakpoint
CREATE INDEX "regie_runs_sheet_idx" ON "regie_runs" USING btree ("cuesheet_id","created_at");--> statement-breakpoint
CREATE INDEX "regie_sounds_sheet_idx" ON "regie_sounds" USING btree ("cuesheet_id");--> statement-breakpoint
ALTER TABLE "regie_cues" ADD CONSTRAINT "regie_cues_dept_chk" CHECK ("department" IN ('light', 'sound', 'video', 'stage', 'fly', 'other'));--> statement-breakpoint
ALTER TABLE "regie_cues" ADD CONSTRAINT "regie_cues_sound_fk" FOREIGN KEY ("sound_id") REFERENCES "regie_sounds"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "regie_runs" ADD CONSTRAINT "regie_runs_mode_chk" CHECK ("mode" IN ('rehearsal', 'show'));--> statement-breakpoint
ALTER TABLE "regie_runs" ADD CONSTRAINT "regie_runs_current_fk" FOREIGN KEY ("current_cue_id") REFERENCES "regie_cues"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "regie_runs" ADD CONSTRAINT "regie_runs_standby_fk" FOREIGN KEY ("standby_cue_id") REFERENCES "regie_cues"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "regie_sounds" ADD CONSTRAINT "regie_sounds_volume_chk" CHECK ("volume" BETWEEN 0 AND 100 AND "fade_in_ms" BETWEEN 0 AND 60000 AND "fade_out_ms" BETWEEN 0 AND 60000);
