export const SYSTEM_ROLE_MCP_JOB: 'system-role-mcp-session';
export const SYSTEM_ROLE_MCP_CAPABILITY: 'system-role-mcp-v2';
export const SYSTEM_ROLE_MCP_LIMITS: Readonly<{
    targets: 2;
    selectedTools: 8;
    discoveredTools: 128;
    pages: 8;
    calls: 6;
    schemaBytes: 16384;
    discoveryBytes: 262144;
    argumentsBytes: 16384;
    outputBytes: 65536;
    contextBytes: 32768;
    sessionMs: 120000;
    callMs: 20000;
    connectMs: 15000;
    discoveryTtlMs: 300000;
}>;
export interface IRoleMcpToolSelection {
    name: string;
    schemaDigest: string;
}
export interface IRoleMcpConfigurationRevision {
    assetId: string;
    manifest: string;
    revision: string | null;
}
interface IRoleMcpTargetBase {
    assetId: string;
    assetKind?: 'mcp' | 'plugin';
    version: number;
    manifest: string;
}
export type TRoleMcpTarget =
    | (IRoleMcpTargetBase & { runtime: 'server' })
    | (IRoleMcpTargetBase & {
          runtime: 'device';
          deviceId: string;
          bindingId: string;
          instanceId: string;
          configurationRevisions: IRoleMcpConfigurationRevision[];
      });
export type TRoleMcpTargetSelection = TRoleMcpTarget & { discoveryId: string; tools: IRoleMcpToolSelection[] };
export interface IRoleMcpTool extends IRoleMcpToolSelection {
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
}
export interface IRoleMcpPreparedTarget {
    target: TRoleMcpTargetSelection;
    tools: Array<IRoleMcpTool & { toolKey: string }>;
}
export interface IRoleMcpOutput {
    text: string;
    isError: boolean;
    truncated: boolean;
    structuredContent?: unknown;
}
export interface IRoleMcpReceipt {
    id: string;
    toolKey: string;
    name: string;
    state: 'succeeded' | 'failed' | 'unknown' | 'cancelled';
    output?: IRoleMcpOutput;
    message: string;
    at: string;
}
export interface IRoleMcpSessionContext {
    sessionId: string;
    jobId: string | null;
    projectId: string;
    target: TRoleMcpTarget;
    package: unknown;
    installSet?: unknown;
    deadlineAt: string;
}
export interface IRoleMcpCallContext {
    id: string;
    kind: 'list' | 'call';
    name?: string;
    schemaDigest?: string;
    arguments?: Record<string, unknown>;
    deadlineAt: string;
    proof?: string;
}
export type TRoleMcpExecutionResult =
    | { state: 'succeeded'; value: { tools: IRoleMcpTool[] } | IRoleMcpOutput }
    | { state: 'failed' | 'unknown'; message: string };
export function systemRoleMcpDigest(value: unknown): string;
export function boundedMcpJson<T>(value: T, maxBytes: number): T;
export function normalizeRoleMcpTarget(value: unknown, selected?: false): TRoleMcpTarget;
export function normalizeRoleMcpSelection(value: unknown): TRoleMcpTargetSelection[] | undefined;
export function normalizeRoleMcpTool(value: unknown): IRoleMcpTool;
export function normalizeRoleMcpDiscovery(value: unknown): IRoleMcpTool[];
export function normalizeRoleMcpOutput(value: unknown): IRoleMcpOutput;
export function normalizeRoleMcpResult(value: unknown, kind: 'list' | 'call'): TRoleMcpExecutionResult;
export function roleMcpToolKey(target: TRoleMcpTarget, name: string): string;
export function roleMcpProducer(
    value: unknown,
): { assetKind: 'mcp' | 'plugin'; entrypoint?: string; args: string[] } | undefined;
export function roleMcpCommand(
    content: string,
    tools: Array<{ toolKey: string }>,
): { kind: 'finish' } | { kind: 'tool'; toolKey: string; arguments: Record<string, unknown> };
