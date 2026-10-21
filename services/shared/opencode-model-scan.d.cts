export interface IOpenCodeModelOptions {temperature?:number;topP?:number;maxOutputTokens?:number;contextWindow?:number}
export interface IOpenCodeModelCandidate {candidateId:string;configKey?:string;outputTokenLimit?:number;provider:string;name:string;model:string;modelVersion:string;capability:'chat'|'vision';runtime:'remote-openai'|'remote-ollama'|null;baseUrl:string|null;hasKey:boolean;credentialSource:'none'|'inline'|'environment'|'file'|'auth';blocker:'unsupported-provider'|'missing-endpoint'|'unresolved-endpoint'|'unsafe-endpoint'|'disabled-provider'|null;options?:IOpenCodeModelOptions;timeoutMs?:number}
export type IOpenCodeModelSource = {scope:'global';deviceId:string} | {scope:'project';projectId:string;bindingId:string;instanceId:string};
export type IOpenCodeModelScan = IOpenCodeModelSource & {schemaVersion:2;scanId:string;checkedAt:string;expiresAt:string;warnings:string[];candidates:IOpenCodeModelCandidate[];digest:string};
export function modelScanDigest(scan:Omit<IOpenCodeModelScan,'digest'>|IOpenCodeModelScan):string;
export function validModelScan(scan:unknown,source:{scope:unknown;deviceId?:unknown;projectId?:unknown;bindingId?:unknown;instanceId?:unknown}):scan is IOpenCodeModelScan;
export const SCAN_WARNINGS:string[];
