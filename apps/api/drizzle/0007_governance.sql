CREATE TABLE "mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"body" text NOT NULL,
	"role" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"meeting_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_attendees" (
	"meeting_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"status" text DEFAULT 'convened' NOT NULL,
	"proxy_member_id" uuid,
	"email_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_attendees_meeting_id_member_id_pk" PRIMARY KEY("meeting_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"location" text,
	"agenda_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quorum_percent" integer,
	"max_proxies" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"convened_at" timestamp with time zone,
	"minutes" text,
	"event_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"text" text,
	"votes_for" integer DEFAULT 0 NOT NULL,
	"votes_against" integer DEFAULT 0 NOT NULL,
	"abstentions" integer DEFAULT 0 NOT NULL,
	"result" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_proxy_member_id_members_id_fk" FOREIGN KEY ("proxy_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mandates_assoc_idx" ON "mandates" USING btree ("association_id");--> statement-breakpoint
CREATE INDEX "meetings_assoc_idx" ON "meetings" USING btree ("association_id","start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "resolutions_number_unique" ON "resolutions" USING btree ("meeting_id","number");--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_status_check" CHECK ("status" IN ('draft','convened','held','closed'));--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_status_check" CHECK ("status" IN ('convened','present','represented','excused','absent'));--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_votes_check" CHECK ("votes_for" >= 0 AND "votes_against" >= 0 AND "abstentions" >= 0);--> statement-breakpoint
-- Une réunion clôturée (procès-verbal figé) ne peut plus être modifiée, ni ses présences ni ses délibérations.
CREATE OR REPLACE FUNCTION scenorya_meeting_closed_guard() RETURNS trigger AS $$
DECLARE mid uuid;
BEGIN
  IF TG_TABLE_NAME = 'meetings' THEN
    IF OLD.closed_at IS NOT NULL THEN RAISE EXCEPTION 'Réunion clôturée : procès-verbal figé'; END IF;
    RETURN NEW;
  END IF;
  mid := COALESCE(NEW.meeting_id, OLD.meeting_id);
  IF EXISTS (SELECT 1 FROM meetings WHERE id = mid AND closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Réunion clôturée : procès-verbal figé';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER meetings_closed_guard BEFORE UPDATE OR DELETE ON meetings FOR EACH ROW EXECUTE FUNCTION scenorya_meeting_closed_guard();--> statement-breakpoint
CREATE TRIGGER meeting_attendees_closed_guard BEFORE INSERT OR UPDATE OR DELETE ON meeting_attendees FOR EACH ROW EXECUTE FUNCTION scenorya_meeting_closed_guard();--> statement-breakpoint
CREATE TRIGGER resolutions_closed_guard BEFORE INSERT OR UPDATE OR DELETE ON resolutions FOR EACH ROW EXECUTE FUNCTION scenorya_meeting_closed_guard();
