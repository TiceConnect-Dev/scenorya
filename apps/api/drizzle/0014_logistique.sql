CREATE TABLE "booking_items" (
	"booking_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"returned_quantity" integer,
	CONSTRAINT "booking_items_booking_id_item_id_pk" PRIMARY KEY("booking_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "booking_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'room' NOT NULL,
	"capacity" integer,
	"location" text,
	"color" text,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"resource_id" uuid,
	"title" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"checked_out_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"requested_by" uuid,
	"contact" text,
	"notes" text,
	"decision_note" text,
	"event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"note" text NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"item_id" uuid,
	"title" text NOT NULL,
	"interval_days" integer NOT NULL,
	"last_done_on" date,
	"next_due_on" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"item_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"units_out" integer DEFAULT 0 NOT NULL,
	"assignee_id" uuid,
	"due_on" date,
	"cost_cents" integer,
	"resolution" text,
	"plan_id" uuid,
	"reported_by" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"name" text NOT NULL,
	"reference" text,
	"category" text,
	"kind" text DEFAULT 'equipment' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit" text,
	"min_quantity" integer,
	"location_id" uuid,
	"brand" text,
	"model" text,
	"serial_number" text,
	"value_cents" integer,
	"purchased_on" date,
	"condition" text DEFAULT 'good' NOT NULL,
	"loanable" boolean DEFAULT true NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"delta" integer NOT NULL,
	"quantity_after" integer NOT NULL,
	"reason" text,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_item_id_stock_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."stock_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resources" ADD CONSTRAINT "booking_resources_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_resource_id_booking_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."booking_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_logs" ADD CONSTRAINT "maintenance_logs_ticket_id_maintenance_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."maintenance_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_logs" ADD CONSTRAINT "maintenance_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_item_id_stock_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."stock_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_item_id_stock_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."stock_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_assignee_id_association_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."association_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_stock_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."stock_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_items_item_idx" ON "booking_items" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "booking_resources_assoc_idx" ON "booking_resources" USING btree ("association_id");--> statement-breakpoint
CREATE INDEX "bookings_assoc_idx" ON "bookings" USING btree ("association_id","start_at");--> statement-breakpoint
CREATE INDEX "bookings_resource_idx" ON "bookings" USING btree ("resource_id","start_at");--> statement-breakpoint
CREATE INDEX "maintenance_plans_assoc_idx" ON "maintenance_plans" USING btree ("association_id","next_due_on");--> statement-breakpoint
CREATE INDEX "maintenance_tickets_assoc_idx" ON "maintenance_tickets" USING btree ("association_id","status");--> statement-breakpoint
CREATE INDEX "maintenance_tickets_item_idx" ON "maintenance_tickets" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "stock_items_assoc_idx" ON "stock_items" USING btree ("association_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_items_ref_unique" ON "stock_items" USING btree ("association_id","reference");--> statement-breakpoint
CREATE INDEX "stock_locations_assoc_idx" ON "stock_locations" USING btree ("association_id");--> statement-breakpoint
CREATE INDEX "stock_movements_item_idx" ON "stock_movements" USING btree ("item_id","created_at");--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_chk" CHECK ("quantity" >= 0 AND ("min_quantity" IS NULL OR "min_quantity" >= 0) AND ("value_cents" IS NULL OR "value_cents" >= 0) AND "kind" IN ('equipment', 'consumable') AND "condition" IN ('good', 'worn', 'broken'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_chk" CHECK ("kind" IN ('in', 'out', 'adjust', 'lost') AND "quantity_after" >= 0);--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_chk" CHECK ("end_at" > "start_at" AND "status" IN ('pending', 'confirmed', 'rejected', 'cancelled'));--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_chk" CHECK ("quantity" > 0 AND ("returned_quantity" IS NULL OR "returned_quantity" BETWEEN 0 AND "quantity"));--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_chk" CHECK ("priority" IN ('low', 'normal', 'high', 'critical') AND "status" IN ('open', 'in_progress', 'waiting_parts', 'done', 'cancelled') AND "units_out" >= 0 AND ("cost_cents" IS NULL OR "cost_cents" >= 0));--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_plan_fk" FOREIGN KEY ("plan_id") REFERENCES "maintenance_plans"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_chk" CHECK ("interval_days" BETWEEN 1 AND 3660);
