export const SYSTEM_ROLE_MCP_JOB:'system-role-mcp-session';
export const SYSTEM_ROLE_MCP_CAPABILITY:'system-role-mcp-v2';
export const SYSTEM_ROLE_MCP_LIMITS:Readonly<{targets:2;selectedTools:8;discoveredTools:128;pages:8;calls:6;schemaBytes:16384;discoveryBytes:262144;argumentsBytes:16384;outputBytes:65536;contextBytes:32768;sessionMs:120000;callMs:20000;connectMs:15000;discoveryTtlMs:300000}>;
export interface RoleMcpToolSelection {name:string;schemaDigest:string}
export interface RoleMcpConfigurationRevision {assetId:string;manifest:string;revision:string|null}
interface RoleMcpTargetBase {assetId:string;assetKind?:'mcp'|'plugin';version:number;manifest:string}
export type RoleMcpTarget=(RoleMcpTargetBase&{runtime:'server'})|(RoleMcpTargetBase&{runtime:'device';deviceId:string;bindingId:string;instanceId:string;configurationRevisions:RoleMcpConfigurationRevision[]});
export type RoleMcpTargetSelection=RoleMcpTarget&{discoveryId:string;tools:RoleMcpToolSelection[]};
export interface RoleMcpTool extends RoleMcpToolSelection {description:string;inputSchema:Record<string,unknown>;outputSchema?:Record<string,unknown>;annotations?:Record<string,unknown>}
export interface RoleMcpPreparedTarget {target:RoleMcpTargetSelection;tools:Array<RoleMcpTool&{toolKey:string}>}
export interface RoleMcpOutput {text:string;isError:boolean;truncated:boolean;structuredContent?:unknown}
export interface RoleMcpReceipt {id:string;toolKey:string;name:string;state:'succeeded'|'failed'|'unknown'|'cancelled';output?:RoleMcpOutput;message:string;at:string}
export interface RoleMcpSessionContext {sessionId:string;jobId:string|null;projectId:string;target:RoleMcpTarget;package:unknown;installSet?:unknown;deadlineAt:string}
export interface RoleMcpCallContext {id:string;kind:'list'|'call';name?:string;schemaDigest?:string;arguments?:Record<string,unknown>;deadlineAt:string;proof?:string}
export type RoleMcpExecutionResult={state:'succeeded';value:{tools:RoleMcpTool[]}|RoleMcpOutput}|{state:'failed'|'unknown';message:string};
export function systemRoleMcpDigest(value:unknown):string;
export function boundedMcpJson<T>(value:T,maxBytes:number):T;
export function normalizeRoleMcpTarget(value:unknown,selected?:false):RoleMcpTarget;
export function normalizeRoleMcpSelection(value:unknown):RoleMcpTargetSelection[]|undefined;
export function normalizeRoleMcpTool(value:unknown):RoleMcpTool;
export function normalizeRoleMcpDiscovery(value:unknown):RoleMcpTool[];
export function normalizeRoleMcpOutput(value:unknown):RoleMcpOutput;
export function normalizeRoleMcpResult(value:unknown,kind:'list'|'call'):RoleMcpExecutionResult;
export function roleMcpToolKey(target:RoleMcpTarget,name:string):string;
export function roleMcpProducer(value:unknown):{assetKind:'mcp'|'plugin';entrypoint?:string;args:string[]}|undefined;
export function roleMcpCommand(content:string,tools:Array<{toolKey:string}>):{kind:'finish'}|{kind:'tool';toolKey:string;arguments:Record<string,unknown>};
