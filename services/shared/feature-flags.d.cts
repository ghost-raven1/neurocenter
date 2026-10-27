export type FeatureFlagKey='project_agent_chat_workflows'|'project_agent_workflows'|'agent_method_workflows'|'service_role_conversations'|'project_agent_tools'|'plugin_auto_updates'|'system_role_guidance'|'chat_system_roles'|'notification_sounds'|'tab_notifications'|'group_discussions'|'bridge_storage_cleanup'|'device_codex_inference'|'model_hosting'|'tool_builds'|'tool_build_agent_recipes'|'tool_build_agent'|'tool_build_validation'|'rag_sync'|'projects'|'computer_connections'|'tool_catalog'|'asset_sources'|'tool_installation'|'model_catalog'|'opencode_model_sync'|'opencode_providers'|'codex_connector'|'agents'|'model_chat'|'chat_activity'|'group_chat'|'project_learning'|'project_learning_memory'|'project_learning_quirks'|'project_search'|'project_snapshots'|'project_backups'|'catalog_requests'|'model_usage'|'local_changes'|'research_tools'|'help_center'|'catalog_reactions'|'discussions'|'discussion_attachments'|'project_chat'|'project_chat_dialogs'|'model_rate_limits'|'card_depth_effect'|'system_coordinator'|'system_ai_admin'|'system_autoconfigurator'|'neural_background'|'project_configuration'|'system_indexer'|'system_role_chat'|'system_role_mcp';
export type FeatureFlagValues=Record<FeatureFlagKey,boolean>;
export interface IFeatureFlagDefinition {key:FeatureFlagKey;name:string;description:string;group:'models'|'catalog'|'knowledge'|'platform'|'agents'|'operations';dependsOn:readonly FeatureFlagKey[];defaultEnabled:boolean}
export interface IFeatureFlag extends Omit<IFeatureFlagDefinition,'defaultEnabled'> {enabled:boolean;revision:number;updatedAt:string;updatedBy:string}
export interface IFeatureFlagList {items:IFeatureFlag[]}
export interface IEvaluatedFeatureFlags {flags:FeatureFlagValues;configured:FeatureFlagValues;blockedBy:Record<FeatureFlagKey,FeatureFlagKey[]>}
export const FEATURE_FLAGS:readonly IFeatureFlagDefinition[];
export const FEATURE_FLAG_KEYS:readonly FeatureFlagKey[];
export function isFeatureFlagKey(value:unknown):value is FeatureFlagKey;
export function defaultFeatureFlags():FeatureFlagValues;
export function evaluateFeatureFlags(configured:FeatureFlagValues):IEvaluatedFeatureFlags;
export function parseEvaluatedFeatureFlags(value:unknown):Pick<IEvaluatedFeatureFlags,'flags'|'blockedBy'>;
