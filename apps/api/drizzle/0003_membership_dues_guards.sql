-- Montants positifs, en centimes.
ALTER TABLE membership_plans ADD CONSTRAINT membership_plans_amount_check CHECK (amount_cents >= 0);
--> statement-breakpoint
ALTER TABLE membership_plans ADD CONSTRAINT membership_plans_period_check CHECK (period_type IN ('calendar_year','fiscal_year','rolling_12m','one_time'));
--> statement-breakpoint
ALTER TABLE membership_dues ADD CONSTRAINT membership_dues_amount_check CHECK (amount_cents >= 0);
--> statement-breakpoint
ALTER TABLE membership_dues ADD CONSTRAINT membership_dues_status_check CHECK (status IN ('due','partial','paid','waived','cancelled'));
--> statement-breakpoint
ALTER TABLE membership_payments ADD CONSTRAINT membership_payments_amount_check CHECK (amount_cents > 0);
--> statement-breakpoint
-- Un règlement n'est jamais supprimé ; seule son annulation (champs cancelled_*) est permise, une seule fois.
CREATE OR REPLACE FUNCTION scenorya_payment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'membership_payments : suppression interdite (annulez le règlement)';
  END IF;
  IF OLD.cancelled_at IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.association_id <> OLD.association_id OR NEW.due_id <> OLD.due_id
     OR NEW.amount_cents <> OLD.amount_cents OR NEW.method <> OLD.method OR NEW.paid_at <> OLD.paid_at
     OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'membership_payments : un règlement enregistré ne peut pas être modifié';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER membership_payments_guard BEFORE UPDATE OR DELETE ON membership_payments
  FOR EACH ROW EXECUTE FUNCTION scenorya_payment_guard();
