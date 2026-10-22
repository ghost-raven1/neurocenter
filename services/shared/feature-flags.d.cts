export type FeatureFlagKey='model_hosting'|'tool_builds'|'rag_sync'|'projects'|'computer_connections'|'tool_catalog'|'asset_sources'|'tool_installation'|'model_catalog'|'opencode_model_sync'|'opencode_providers'|'codex_connector'|'agents'|'model_chat'|'group_chat'|'project_learning'|'project_search'|'project_snapshots'|'project_backups'|'catalog_requests'|'model_usage'|'local_changes'|'research_tools';
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
