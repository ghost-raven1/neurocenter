export interface IOpenCodeModelCandidate {candidateId:string;provider:string;name:string;model:string;modelVersion:string;capability:'chat'|'vision';runtime:'remote-openai'|'remote-ollama'|null;baseUrl:string|null;hasKey:boolean;credentialSource:'none'|'inline'|'environment'|'file'|'auth';blocker:'unsupported-provider'|'missing-endpoint'|'unresolved-endpoint'|'unsafe-endpoint'|'disabled-provider'|null}
export interface IOpenCodeModelScan {schemaVersion:1;projectId:string;bindingId:string;instanceId:string;scanId:string;checkedAt:string;expiresAt:string;warnings:string[];candidates:IOpenCodeModelCandidate[];digest:string}
export function modelScanDigest(scan:Omit<IOpenCodeModelScan,'digest'>|IOpenCodeModelScan):string;
export function validModelScan(scan:unknown,source:{projectId:unknown;bindingId:unknown;instanceId:unknown}):scan is IOpenCodeModelScan;
export const SCAN_WARNINGS:string[];
