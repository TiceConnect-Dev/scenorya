-- Suppression définitive contrôlée : l'application l'autorise explicitement, dans la transaction,
-- par set_config('scenorya.allow_purge', 'on', true), après confirmation de l'utilisateur et
-- inscription au journal d'audit (qui, lui, reste en ajout seul). Les modifications restent interdites.
CREATE OR REPLACE FUNCTION scenorya_payment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('scenorya.allow_purge', true) = 'on' THEN RETURN OLD; END IF;
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
-- Correctif : une suppression doit renvoyer OLD (renvoyer NEW, nul, annulait la suppression sans erreur).
CREATE OR REPLACE FUNCTION scenorya_meeting_closed_guard() RETURNS trigger AS $$
DECLARE mid uuid;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('scenorya.allow_purge', true) = 'on' THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME = 'meetings' THEN
    IF OLD.closed_at IS NOT NULL THEN RAISE EXCEPTION 'Réunion clôturée : procès-verbal figé'; END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  mid := COALESCE(NEW.meeting_id, OLD.meeting_id);
  IF EXISTS (SELECT 1 FROM meetings WHERE id = mid AND closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Réunion clôturée : procès-verbal figé';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
