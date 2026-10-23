export const PROJECT_CONFIGURATION_JOB:'open-project-configuration';
export const PROJECT_CONFIGURATION_CAPABILITY:'project-configuration-v1';
export interface ProjectConfigurationRagRef {kind:'mcp'|'plugin';id:string;version:number;manifest:string}
export interface ProjectConfigurationSession {schemaVersion:1;deviceId:string;projectId:string;bindingId:string;instanceId:string;sessionId:string;expiresAt:string;ragInstallations:ProjectConfigurationRagRef[]}
export interface ProjectConfigurationOpened extends ProjectConfigurationSession {opened:true}
export function normalizeProjectConfigurationSession(value:unknown):ProjectConfigurationSession;
export function normalizeProjectConfigurationReport(value:unknown,session:unknown,failed?:boolean):ProjectConfigurationOpened|Record<string,never>;
