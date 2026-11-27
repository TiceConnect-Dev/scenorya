-- Journal d'audit en ajout seul : toute modification ou suppression est refusée
-- au niveau de la base, y compris pour l'utilisateur applicatif.
CREATE OR REPLACE FUNCTION scenorya_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs est en ajout seul (opération % refusée)', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION scenorya_audit_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION scenorya_audit_immutable();
--> statement-breakpoint
-- L'historique de configuration des modules est également en ajout seul.
CREATE TRIGGER module_history_no_update BEFORE UPDATE OR DELETE ON module_config_history
  FOR EACH ROW EXECUTE FUNCTION scenorya_audit_immutable();
