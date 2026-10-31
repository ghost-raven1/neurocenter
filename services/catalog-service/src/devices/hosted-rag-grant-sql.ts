/** Only the migration runner creates tables and revocation triggers. */
export const HOSTED_RAG_GRANT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bridge_hosted_rag_grants(
        id UUID PRIMARY KEY,authorization_order BIGSERIAL NOT NULL,device_id TEXT NOT NULL REFERENCES bridge_devices(id),project_id TEXT NOT NULL,email TEXT NOT NULL,role TEXT NOT NULL,
        binding_id TEXT NOT NULL,instance_id TEXT NOT NULL,asset_kind TEXT NOT NULL CHECK(asset_kind IN ('mcp','plugin')),asset_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version>0),manifest TEXT NOT NULL CHECK(manifest ~ '^[a-f0-9]{64}$'),selection_revision BIGINT NOT NULL CHECK(selection_revision>0),
        model_id TEXT NOT NULL,model_pin TEXT NOT NULL CHECK(model_pin ~ '^[a-f0-9]{64}$'),model_assignment_epoch UUID NOT NULL,
        payload JSONB NOT NULL,job_id TEXT NOT NULL UNIQUE REFERENCES bridge_jobs(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),revoked_at TIMESTAMPTZ);
        ALTER TABLE bridge_hosted_rag_grants ADD COLUMN IF NOT EXISTS authorization_order BIGSERIAL NOT NULL;
        CREATE INDEX IF NOT EXISTS bridge_hosted_grant_scope ON bridge_hosted_rag_grants(device_id,project_id,binding_id,instance_id) WHERE revoked_at IS NULL;
        CREATE TABLE IF NOT EXISTS bridge_hosted_grant_migrations(name TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
`;
export const HOSTED_RAG_REVOCATION_SQL = `
CREATE OR REPLACE FUNCTION revoke_hosted_rag_grants() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_TABLE_NAME='project_models' THEN
                UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE project_id=OLD.project_id AND model_id=OLD.model_id AND revoked_at IS NULL;
            ELSIF TG_TABLE_NAME='project_embedding_settings' THEN
                IF TG_OP='DELETE' OR (OLD.model_id IS NOT NULL AND NEW.model_id IS NULL) THEN
                    UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE project_id=OLD.project_id AND revoked_at IS NULL;
                END IF;
            ELSIF TG_TABLE_NAME='project_assets' THEN
                IF TG_OP='DELETE' OR OLD.asset_version IS DISTINCT FROM NEW.asset_version OR OLD.asset_manifest IS DISTINCT FROM NEW.asset_manifest THEN
                    UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE project_id=OLD.project_id
                        AND payload->'approvalRoot'->>'id'=OLD.asset_id AND payload->'approvalRoot'->>'kind'=OLD.asset_kind AND revoked_at IS NULL;
                END IF;
            ELSIF TG_TABLE_NAME='device_install_plans' THEN
                IF NEW.status IS DISTINCT FROM OLD.status OR NEW.revision IS DISTINCT FROM OLD.revision THEN
                    UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE payload->>'planId'=OLD.id::text AND revoked_at IS NULL;
                END IF;
            ELSIF TG_TABLE_NAME='bridge_devices' THEN
                UPDATE bridge_hosted_rag_grants g SET revoked_at=now() WHERE g.device_id=NEW.id AND g.revoked_at IS NULL
                    AND (NEW.revoked OR NEW.email<>OLD.email OR NEW.role<>OLD.role OR EXISTS(
                        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.report->'bindings')='array' THEN NEW.report->'bindings' ELSE '[]'::jsonb END) b
                        WHERE b->>'projectId'=g.project_id AND b->>'valid'='true'
                        AND (b->>'bindingId' IS DISTINCT FROM g.binding_id OR b->>'instanceId' IS DISTINCT FROM g.instance_id)));
            ELSIF TG_TABLE_NAME='project_members' THEN
                IF TG_OP='DELETE' OR OLD.role IS DISTINCT FROM NEW.role OR OLD.principal_name IS DISTINCT FROM NEW.principal_name THEN
                    UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE project_id=OLD.project_id AND lower(email)=lower(OLD.principal_name) AND revoked_at IS NULL;
                END IF;
            ELSIF TG_TABLE_NAME='platform_users' THEN
                IF NOT NEW.enabled OR (OLD.is_main_admin AND NOT NEW.is_main_admin) THEN
                    UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE lower(email)=lower(OLD.email) AND revoked_at IS NULL
                        AND (NOT NEW.enabled OR role='Главный админ');
                END IF;
            ELSIF TG_TABLE_NAME='model_remote_connections' THEN
                IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
                    UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE model_id=NEW.model_id AND revoked_at IS NULL;
                END IF;
            ELSIF TG_TABLE_NAME='bridge_jobs' THEN
                IF NEW.state='succeeded' AND OLD.state<>'succeeded' AND NEW.kind IN ('install','uninstall','apply-local-change','apply-adopt-installation') THEN
                    UPDATE bridge_hosted_rag_grants g SET revoked_at=now() WHERE g.device_id=NEW.device_id AND g.project_id=NEW.project_id
                        AND g.binding_id=NEW.payload->>'bindingId' AND g.revoked_at IS NULL AND EXISTS(
                            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.payload->'installSet'->'packages')='array' THEN NEW.payload->'installSet'->'packages' ELSE jsonb_build_array(NEW.payload->'package') END) p
                            WHERE p->'plugin'->>'kind'=g.asset_kind AND p->'plugin'->>'id'=g.asset_id
                            AND (NEW.kind='uninstall' OR p->'manifest'->>'sha256'<>g.manifest OR p->'plugin'->>'version'<>g.version::text));
                END IF;
            END IF;
            RETURN NULL;
        END $$;;
DROP TRIGGER IF EXISTS hosted_rag_grant_revoke ON project_models; CREATE TRIGGER hosted_rag_grant_revoke AFTER DELETE ON project_models FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants();
DROP TRIGGER IF EXISTS hosted_rag_grant_revoke ON project_embedding_settings; CREATE TRIGGER hosted_rag_grant_revoke AFTER UPDATE OR DELETE ON project_embedding_settings FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants();
DROP TRIGGER IF EXISTS hosted_rag_grant_revoke ON project_assets; CREATE TRIGGER hosted_rag_grant_revoke AFTER UPDATE OR DELETE ON project_assets FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants();
DROP TRIGGER IF EXISTS hosted_rag_grant_revoke ON device_install_plans; CREATE TRIGGER hosted_rag_grant_revoke AFTER UPDATE ON device_install_plans FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants();
DROP TRIGGER IF EXISTS hosted_rag_grant_revoke ON bridge_devices; CREATE TRIGGER hosted_rag_grant_revoke AFTER UPDATE ON bridge_devices FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants();
DROP TRIGGER IF EXISTS hosted_rag_grant_revoke ON project_members; CREATE TRIGGER hosted_rag_grant_revoke AFTER UPDATE OR DELETE ON project_members FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants();
DROP TRIGGER IF EXISTS hosted_rag_grant_revoke ON platform_users; CREATE TRIGGER hosted_rag_grant_revoke AFTER UPDATE ON platform_users FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants();
DROP TRIGGER IF EXISTS hosted_rag_grant_revoke ON bridge_jobs; CREATE TRIGGER hosted_rag_grant_revoke AFTER UPDATE ON bridge_jobs FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants();
DROP TRIGGER IF EXISTS hosted_rag_grant_revoke ON model_remote_connections; CREATE TRIGGER hosted_rag_grant_revoke AFTER UPDATE ON model_remote_connections FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants();
`;
