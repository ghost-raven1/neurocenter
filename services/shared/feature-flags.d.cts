export type FeatureFlagKey='model_hosting'|'tool_builds'|'rag_sync';
export type FeatureFlagValues=Record<FeatureFlagKey,boolean>;
export interface IFeatureFlagDefinition {key:FeatureFlagKey;name:string;description:string;defaultEnabled:true}
export interface IFeatureFlag extends Omit<IFeatureFlagDefinition,'defaultEnabled'> {enabled:boolean;revision:number;updatedAt:string;updatedBy:string}
export interface IFeatureFlagList {items:IFeatureFlag[]}
export interface IEvaluatedFeatureFlags {flags:FeatureFlagValues}
export const FEATURE_FLAGS:readonly IFeatureFlagDefinition[];
export const FEATURE_FLAG_KEYS:readonly FeatureFlagKey[];
export function isFeatureFlagKey(value:unknown):value is FeatureFlagKey;
export function defaultFeatureFlags():FeatureFlagValues;
