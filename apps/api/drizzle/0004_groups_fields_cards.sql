CREATE TABLE "member_field_defs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"options" text[] DEFAULT '{}'::text[] NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_group_links" (
	"group_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_group_links_group_id_member_id_pk" PRIMARY KEY("group_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "member_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'group' NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "custom" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "card_token" text;--> statement-breakpoint
ALTER TABLE "member_field_defs" ADD CONSTRAINT "member_field_defs_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_group_links" ADD CONSTRAINT "member_group_links_group_id_member_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."member_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_group_links" ADD CONSTRAINT "member_group_links_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_groups" ADD CONSTRAINT "member_groups_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_field_defs_key_unique" ON "member_field_defs" USING btree ("association_id","key");--> statement-breakpoint
CREATE INDEX "member_group_links_member_idx" ON "member_group_links" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_groups_name_unique" ON "member_groups" USING btree ("association_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "members_card_token_unique" ON "members" USING btree ("card_token");