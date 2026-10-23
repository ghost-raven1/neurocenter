export interface IOpenCodeModelOptions {temperature?:number;topP?:number;maxOutputTokens?:number;contextWindow?:number;apiFormat?:'chat-completions'|'responses';reasoningEffort?:'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max';store?:boolean}
export interface IOpenCodeModelCandidate {candidateId:string;configKey?:string;outputTokenLimit?:number;provider:string;name:string;model:string;modelVersion:string;capability:'chat'|'vision';runtime:'remote-openai'|'remote-ollama'|null;baseUrl:string|null;hasKey:boolean;credentialSource:'none'|'inline'|'environment'|'file'|'auth';blocker:'unsupported-provider'|'missing-endpoint'|'unresolved-endpoint'|'unsafe-endpoint'|'disabled-provider'|'codex-local-auth'|'local-provider-auth'|'device-local-endpoint'|null;options?:IOpenCodeModelOptions;parameterIssues?:Array<{name:string;type:string}>;timeoutMs?:number}
export type IOpenCodeModelSource = {scope:'global';deviceId:string} | {scope:'project';projectId:string;bindingId:string;instanceId:string};
export type IOpenCodeModelScan = IOpenCodeModelSource & {schemaVersion:2;scanId:string;checkedAt:string;expiresAt:string;warnings:string[];candidates:IOpenCodeModelCandidate[];digest:string};
export function modelScanDigest(scan:Omit<IOpenCodeModelScan,'digest'>|IOpenCodeModelScan):string;
export function validModelScan(scan:unknown,source:{scope:unknown;deviceId?:unknown;projectId?:unknown;bindingId?:unknown;instanceId?:unknown}):scan is IOpenCodeModelScan;
export function validModelOptions(value:unknown):value is IOpenCodeModelOptions;
export function serverImportBlocker(candidate:Pick<IOpenCodeModelCandidate,'provider'|'baseUrl'>):'codex-local-auth'|'device-local-endpoint'|null;
export const SCAN_WARNINGS:string[];
