import type {FeatureFlagKey} from './feature-flags.cjs';
export function requiredRouteFeatures(method:string,path:string,body?:unknown):FeatureFlagKey[];
export function requiredJobFeatures(kind:string,payload?:unknown,trustedPayload?:boolean):FeatureFlagKey[];
export function requiredAssetFeatures(kind:string):FeatureFlagKey[];
export function requiredInferenceFeatures(purpose:string,agentId?:string|null):FeatureFlagKey[];
