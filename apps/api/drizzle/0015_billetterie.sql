CREATE TABLE "ticket_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"performance_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"start_at" timestamp with time zone NOT NULL,
	"venue" text,
	"capacity" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"public_sale" boolean DEFAULT false NOT NULL,
	"sales_open_at" timestamp with time zone,
	"sales_close_at" timestamp with time zone,
	"max_per_order" integer DEFAULT 10 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"number" text NOT NULL,
	"buyer_name" text NOT NULL,
	"buyer_email" text,
	"buyer_phone" text,
	"status" text DEFAULT 'paid' NOT NULL,
	"channel" text DEFAULT 'box_office' NOT NULL,
	"payment_method" text,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"notes" text,
	"public_token" text NOT NULL,
	"ip_hash" text,
	"email_status" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"quota" integer,
	"public_visible" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_scans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"ticket_id" uuid,
	"result" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"offline" boolean DEFAULT false NOT NULL,
	"device" text,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"rate_id" uuid,
	"rate_name" text NOT NULL,
	"price_cents" integer NOT NULL,
	"code" text NOT NULL,
	"holder_name" text,
	"status" text DEFAULT 'valid' NOT NULL,
	"scanned_at" timestamp with time zone,
	"scanned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_performance_id_show_performances_id_fk" FOREIGN KEY ("performance_id") REFERENCES "public"."show_performances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_orders" ADD CONSTRAINT "ticket_orders_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_orders" ADD CONSTRAINT "ticket_orders_event_id_ticket_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."ticket_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_orders" ADD CONSTRAINT "ticket_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_rates" ADD CONSTRAINT "ticket_rates_event_id_ticket_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."ticket_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_scans" ADD CONSTRAINT "ticket_scans_event_id_ticket_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."ticket_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_scans" ADD CONSTRAINT "ticket_scans_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_scans" ADD CONSTRAINT "ticket_scans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_id_ticket_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ticket_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_event_id_ticket_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."ticket_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_rate_id_ticket_rates_id_fk" FOREIGN KEY ("rate_id") REFERENCES "public"."ticket_rates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_scanned_by_users_id_fk" FOREIGN KEY ("scanned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_events_assoc_idx" ON "ticket_events" USING btree ("association_id","start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_events_perf_unique" ON "ticket_events" USING btree ("performance_id");--> statement-breakpoint
CREATE INDEX "ticket_orders_event_idx" ON "ticket_orders" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_orders_number_unique" ON "ticket_orders" USING btree ("association_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_orders_token_unique" ON "ticket_orders" USING btree ("public_token");--> statement-breakpoint
CREATE INDEX "ticket_rates_event_idx" ON "ticket_rates" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "ticket_scans_event_idx" ON "ticket_scans" USING btree ("event_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_code_unique" ON "tickets" USING btree ("code");--> statement-breakpoint
CREATE INDEX "tickets_event_idx" ON "tickets" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "tickets_order_idx" ON "tickets" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_status_check" CHECK ("status" in ('draft', 'on_sale', 'closed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_capacity_check" CHECK ("capacity" is null or "capacity" >= 0);--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_max_check" CHECK ("max_per_order" between 1 and 100);--> statement-breakpoint
ALTER TABLE "ticket_rates" ADD CONSTRAINT "ticket_rates_price_check" CHECK ("price_cents" >= 0 and ("quota" is null or "quota" >= 0));--> statement-breakpoint
ALTER TABLE "ticket_orders" ADD CONSTRAINT "ticket_orders_status_check" CHECK ("status" in ('pending', 'paid', 'cancelled'));--> statement-breakpoint
ALTER TABLE "ticket_orders" ADD CONSTRAINT "ticket_orders_channel_check" CHECK ("channel" in ('box_office', 'online', 'invitation'));--> statement-breakpoint
ALTER TABLE "ticket_orders" ADD CONSTRAINT "ticket_orders_payment_check" CHECK ("payment_method" is null or "payment_method" in ('cash', 'card', 'cheque', 'transfer', 'free', 'other'));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_status_check" CHECK ("status" in ('valid', 'cancelled'));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_price_check" CHECK ("price_cents" >= 0);
