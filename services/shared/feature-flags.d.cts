export type TFeatureFlagKey =
    | 'catalog_supplies_navigation'
    | 'project_update_apply'
    | 'installation_auto_inspect'
    | 'project_binding_inline'
    | 'opencode_v2_accounts'
    | 'opencode_personal_key_transfer'
    | 'personal_remote_provider_credentials'
    | 'gguf_import'
    | 'unified_project_setup'
    | 'project_agent_chat_workflows'
    | 'project_agent_workflows'
    | 'agent_method_workflows'
    | 'service_role_conversations'
    | 'project_agent_tools'
    | 'plugin_auto_updates'
    | 'system_role_guidance'
    | 'chat_system_roles'
    | 'notification_sounds'
    | 'tab_notifications'
    | 'group_discussions'
    | 'bridge_storage_cleanup'
    | 'device_codex_inference'
    | 'model_hosting'
    | 'tool_builds'
    | 'tool_build_agent_recipes'
    | 'tool_build_agent'
    | 'tool_build_validation'
    | 'rag_sync'
    | 'projects'
    | 'computer_connections'
    | 'computer_setup'
    | 'tool_catalog'
    | 'asset_sources'
    | 'tool_installation'
    | 'model_catalog'
    | 'opencode_model_sync'
    | 'opencode_providers'
    | 'codex_connector'
    | 'agents'
    | 'model_chat'
    | 'chat_activity'
    | 'group_chat'
    | 'project_learning'
    | 'project_learning_memory'
    | 'project_learning_quirks'
    | 'runtime_limit_configuration'
    | 'project_text_knowledge'
    | 'project_search'
    | 'project_snapshots'
    | 'project_backups'
    | 'catalog_requests'
    | 'model_usage'
    | 'local_changes'
    | 'research_tools'
    | 'help_center'
    | 'catalog_reactions'
    | 'discussions'
    | 'discussion_attachments'
    | 'project_chat'
    | 'project_chat_dialogs'
    | 'model_rate_limits'
    | 'user_model_token_quotas'
    | 'card_depth_effect'
    | 'system_coordinator'
    | 'system_ai_admin'
    | 'system_autoconfigurator'
    | 'neural_background'
    | 'project_configuration'
    | 'system_indexer'
    | 'system_role_chat'
    | 'system_role_mcp';
export type TFeatureFlagValues = Record<TFeatureFlagKey, boolean>;
export interface IFeatureFlagDefinition {
    key: TFeatureFlagKey;
    name: string;
    description: string;
    group: 'models' | 'catalog' | 'knowledge' | 'platform' | 'agents' | 'operations';
    dependsOn: readonly TFeatureFlagKey[];
    defaultEnabled: boolean;
}
export interface IFeatureFlag extends Omit<IFeatureFlagDefinition, 'defaultEnabled'> {
    enabled: boolean;
    revision: number;
    updatedAt: string;
    updatedBy: string;
}
export interface IFeatureFlagList {
    items: IFeatureFlag[];
}
export interface IEvaluatedFeatureFlags {
    flags: TFeatureFlagValues;
    configured: TFeatureFlagValues;
    blockedBy: Record<TFeatureFlagKey, TFeatureFlagKey[]>;
}
export const FEATURE_FLAGS: readonly IFeatureFlagDefinition[];
export const FEATURE_FLAG_KEYS: readonly TFeatureFlagKey[];
export function isFeatureFlagKey(value: unknown): value is TFeatureFlagKey;
export function defaultFeatureFlags(): TFeatureFlagValues;
export function evaluateFeatureFlags(configured: TFeatureFlagValues): IEvaluatedFeatureFlags;
export function parseEvaluatedFeatureFlags(value: unknown): Pick<IEvaluatedFeatureFlags, 'flags' | 'blockedBy'>;
