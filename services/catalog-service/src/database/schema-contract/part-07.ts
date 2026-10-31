/** Frozen schema facts captured from the complete catalog migrations in an empty PostgreSQL database. */
export const SCHEMA_PART_07 = [
    { kind: 'table', id: 'model_remote_connections', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'operation_action_requests', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'operations', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'platform_bootstrap', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'platform_users', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_assets', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_backups', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_embedding_settings', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_members', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_models', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_rag_sync_intents', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_reindex_plans', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_retirements', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_snapshot_blob_refs', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_snapshot_blob_writes', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_snapshot_blobs', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_snapshot_cancelled_commands', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_snapshot_cancelled_requests', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_snapshot_commands', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_snapshot_profiles', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_snapshot_verifiers', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_snapshots', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'projects', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'retired_rag_previews', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'retired_rag_purges', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'security_events', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'skill_audit_receipts', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'skill_dependency_reservations', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'tool_build_jobs', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'tool_source_uploads', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'web_restore_cancelled_requests', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'web_restore_jobs', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'web_restore_runner', definition: { kind: 'r', persistence: 'p' } },
    {
        kind: 'trigger',
        id: 'bridge_devices.hosted_rag_grant_revoke',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER hosted_rag_grant_revoke AFTER UPDATE ON bridge_devices FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants()',
        },
    },
    {
        kind: 'trigger',
        id: 'bridge_hosted_rag_grants.neurocenter_retired_reference_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON bridge_hosted_rag_grants FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard()',
        },
    },
    {
        kind: 'trigger',
        id: 'bridge_jobs.hosted_rag_grant_revoke',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER hosted_rag_grant_revoke AFTER UPDATE ON bridge_jobs FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants()',
        },
    },
    {
        kind: 'trigger',
        id: 'bridge_jobs.neurocenter_retired_reference_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON bridge_jobs FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard()',
        },
    },
    {
        kind: 'trigger',
        id: 'bridge_jobs.project_reindex_local_operation',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER project_reindex_local_operation AFTER UPDATE OF state, percent, message ON bridge_jobs FOR EACH ROW EXECUTE FUNCTION project_reindex_local_operation()',
        },
    },
    {
        kind: 'trigger',
        id: 'bridge_jobs.snapshot_job_terminal',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER snapshot_job_terminal AFTER UPDATE OF state ON bridge_jobs FOR EACH ROW WHEN (old.state IS DISTINCT FROM new.state) EXECUTE FUNCTION snapshot_job_failed()',
        },
    },
    {
        kind: 'trigger',
        id: 'device_install_plans.hosted_rag_grant_revoke',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER hosted_rag_grant_revoke AFTER UPDATE ON device_install_plans FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants()',
        },
    },
    {
        kind: 'trigger',
        id: 'model_remote_connections.hosted_rag_grant_revoke',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER hosted_rag_grant_revoke AFTER UPDATE ON model_remote_connections FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants()',
        },
    },
    {
        kind: 'trigger',
        id: 'platform_users.hosted_rag_grant_revoke',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER hosted_rag_grant_revoke AFTER UPDATE ON platform_users FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants()',
        },
    },
    {
        kind: 'trigger',
        id: 'platform_users.source_upload_access_epoch',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER source_upload_access_epoch BEFORE UPDATE OF is_main_admin, enabled ON platform_users FOR EACH ROW EXECUTE FUNCTION rotate_source_upload_auth_epoch()',
        },
    },
    {
        kind: 'trigger',
        id: 'project_assets.hosted_rag_grant_revoke',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER hosted_rag_grant_revoke AFTER DELETE OR UPDATE ON project_assets FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants()',
        },
    },
    {
        kind: 'trigger',
        id: 'project_embedding_settings.hosted_rag_grant_revoke',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER hosted_rag_grant_revoke AFTER DELETE OR UPDATE ON project_embedding_settings FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants()',
        },
    },
    {
        kind: 'trigger',
        id: 'project_members.hosted_rag_grant_revoke',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER hosted_rag_grant_revoke AFTER DELETE OR UPDATE ON project_members FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants()',
        },
    },
    {
        kind: 'trigger',
        id: 'project_models.hosted_rag_grant_revoke',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER hosted_rag_grant_revoke AFTER DELETE ON project_models FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants()',
        },
    },
    {
        kind: 'trigger',
        id: 'project_reindex_plans.project_reindex_operation',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER project_reindex_operation AFTER INSERT OR UPDATE ON project_reindex_plans FOR EACH ROW EXECUTE FUNCTION project_reindex_operation()',
        },
    },
    {
        kind: 'trigger',
        id: 'projects.neurocenter_project_retirement_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_project_retirement_guard BEFORE INSERT OR UPDATE OF id ON projects FOR EACH ROW EXECUTE FUNCTION neurocenter_project_retirement_guard()',
        },
    },
];
