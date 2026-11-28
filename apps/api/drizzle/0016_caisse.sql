CREATE TABLE "pos_cash_moves" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_payments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"tendered_cents" integer
);
--> statement-breakpoint
CREATE TABLE "pos_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"category_id" uuid,
	"name" text NOT NULL,
	"price_cents" integer NOT NULL,
	"color" text,
	"stock_item_id" uuid,
	"stock_units" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_registers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"ticket_sales" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_sale_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"kind" text DEFAULT 'product' NOT NULL,
	"product_id" uuid,
	"ticket_rate_id" uuid,
	"name" text NOT NULL,
	"category" text,
	"unit_price_cents" integer NOT NULL,
	"quantity" integer NOT NULL,
	"stock_item_id" uuid,
	"stock_units" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"number" text NOT NULL,
	"total_cents" integer NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"ticket_order_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opening_float_cents" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"expected_cash_cents" integer,
	"counted_cash_cents" integer,
	"cash_count" jsonb,
	"notes" text,
	"event_id" uuid
);
--> statement-breakpoint
ALTER TABLE "pos_cash_moves" ADD CONSTRAINT "pos_cash_moves_session_id_pos_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."pos_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_moves" ADD CONSTRAINT "pos_cash_moves_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_categories" ADD CONSTRAINT "pos_categories_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_sale_id_pos_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."pos_sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_products" ADD CONSTRAINT "pos_products_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_products" ADD CONSTRAINT "pos_products_category_id_pos_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."pos_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_products" ADD CONSTRAINT "pos_products_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_sale_id_pos_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."pos_sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_product_id_pos_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."pos_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_ticket_rate_id_ticket_rates_id_fk" FOREIGN KEY ("ticket_rate_id") REFERENCES "public"."ticket_rates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_session_id_pos_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."pos_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_ticket_order_id_ticket_orders_id_fk" FOREIGN KEY ("ticket_order_id") REFERENCES "public"."ticket_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sessions" ADD CONSTRAINT "pos_sessions_association_id_associations_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."associations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sessions" ADD CONSTRAINT "pos_sessions_register_id_pos_registers_id_fk" FOREIGN KEY ("register_id") REFERENCES "public"."pos_registers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sessions" ADD CONSTRAINT "pos_sessions_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sessions" ADD CONSTRAINT "pos_sessions_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sessions" ADD CONSTRAINT "pos_sessions_event_id_ticket_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."ticket_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pos_categories_assoc_idx" ON "pos_categories" USING btree ("association_id");--> statement-breakpoint
CREATE INDEX "pos_payments_sale_idx" ON "pos_payments" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "pos_products_assoc_idx" ON "pos_products" USING btree ("association_id");--> statement-breakpoint
CREATE INDEX "pos_registers_assoc_idx" ON "pos_registers" USING btree ("association_id");--> statement-breakpoint
CREATE INDEX "pos_sale_lines_sale_idx" ON "pos_sale_lines" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "pos_sales_session_idx" ON "pos_sales" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "pos_sessions_register_idx" ON "pos_sessions" USING btree ("register_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sessions_open_unique" ON "pos_sessions" USING btree ("register_id") WHERE status = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sessions_number_unique" ON "pos_sessions" USING btree ("association_id","number");--> statement-breakpoint
ALTER TABLE "pos_products" ADD CONSTRAINT "pos_products_price_check" CHECK ("price_cents" >= 0 and "stock_units" >= 0);--> statement-breakpoint
ALTER TABLE "pos_sessions" ADD CONSTRAINT "pos_sessions_status_check" CHECK ("status" in ('open', 'closed') and "opening_float_cents" >= 0);--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_status_check" CHECK ("status" in ('completed', 'voided'));--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_check" CHECK ("kind" in ('product', 'ticket', 'custom') and "quantity" > 0 and "unit_price_cents" >= 0);--> statement-breakpoint
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_check" CHECK ("method" in ('cash', 'card', 'cheque', 'other') and "amount_cents" >= 0);--> statement-breakpoint
ALTER TABLE "pos_cash_moves" ADD CONSTRAINT "pos_cash_moves_check" CHECK ("kind" in ('in', 'out') and "amount_cents" > 0);
