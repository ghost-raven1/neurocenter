export type OpenCodeProviderKind='openai-compatible'|'codex-bridge';
export type OpenCodeProviderJobKind='prepare-opencode-provider'|'open-opencode-provider'|'get-opencode-provider-status';
export interface OpenCodeProviderExpectations {catalogModelId:string;modelPin:string;runtimeModel:string;capability:'chat'|'vision';baseUrl:string;options:{temperature?:number;topP?:number;maxOutputTokens?:number;contextWindow?:number}}
export interface OpenCodeConnectorReference {assetId:string;version:number;manifest:string;sourceCommit:string}
export interface OpenCodeProviderDescriptor {schemaVersion:1;deviceId:string;projectId:string;bindingId:string;instanceId:string;providerKind:OpenCodeProviderKind;providerId:string;schemaDigest:string;expectations:OpenCodeProviderExpectations|null;connector:OpenCodeConnectorReference|null}
export interface OpenCodeProviderIdentity extends Omit<OpenCodeProviderDescriptor,'expectations'> {catalogModelId:string|null;modelPin:string|null}
export interface OpenCodeProviderPreparation extends OpenCodeProviderIdentity {preparationId:string;expiresAt:string}
export interface OpenCodeProviderOpened extends OpenCodeProviderPreparation {opened:true}
export interface OpenCodeProviderStatus extends OpenCodeProviderIdentity {state:'missing'|'configured'|'login-required'|'unavailable'|'conflict';ready:boolean;missingFields:Array<'baseUrl'|'credential'|'login'>;revision:string|null;checkedAt:string}
export const OPENCODE_PROVIDER_CAPABILITY:'opencode-providers-v1';
export const OPENCODE_PROVIDER_JOBS:OpenCodeProviderJobKind[];
export function normalizeProviderDescriptor(value:unknown):OpenCodeProviderDescriptor;
export function providerReportIdentity(value:unknown):OpenCodeProviderIdentity;
export function normalizeProviderReport(kind:string,value:unknown,descriptor:unknown,failed?:boolean,preparationId?:string):OpenCodeProviderPreparation|OpenCodeProviderOpened|OpenCodeProviderStatus|Record<string,never>;
