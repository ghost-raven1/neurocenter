export const OPENCODE_CLI_INSTALL_JOB:'install-opencode-cli';
export const OPENCODE_CLI_INSTALL_CAPABILITY:'opencode-cli-install-v1';
export const OPENCODE_CLI_INSTALL_VERSION:'1.14.48';
export const OPENCODE_CLI_INSTALL_TARGETS:readonly string[];
export const OPENCODE_CLI_INSTALL_SCHEMAS:Record<'request'|'supply'|'payload'|'success'|'failure'|'result',Record<string,unknown>>;
export interface OpenCodeInstallSupply {buildId:string;target:string;version:'1.14.48';sha256:string}
export interface OpenCodeInstallRequest {deviceId:string;kind:'install-opencode-cli';scope:'global';requestKey:string}
export interface OpenCodeInstallPayload {schemaVersion:1;scope:'global';deviceId:string;source:OpenCodeInstallSupply}
export type OpenCodeInstallFailure='source-changed'|'source-unavailable'|'existing-cli-unavailable'|'destination-unsafe'|'destination-changed'|'install-busy'|'verification-failed'|'cancelled'|'authorization-lost'|'interrupted'|'install-failed';
export interface OpenCodeInstallResult extends OpenCodeInstallPayload {
    jobId:string;checkedAt:string;status:'installed'|'unchanged'|'failed'|'unknown';installedVersion:string|null;commandVersion:string|null;
    commandReady:boolean;nextAction:'none'|'inspect-path'|'retry'|'reconcile';failure?:OpenCodeInstallFailure;
}
export function normalizeOpenCodeInstallRequest(value:unknown):OpenCodeInstallRequest;
export function normalizeOpenCodeInstallSupply(value:unknown):OpenCodeInstallSupply;
export function openCodeInstallRuntimeTarget(target:string):string;
export function normalizeOpenCodeInstallPayload(value:unknown):OpenCodeInstallPayload;
export function normalizeOpenCodeInstallResult(value:unknown,expected?:{deviceId:string;jobId:string;source:OpenCodeInstallSupply}):OpenCodeInstallResult;
