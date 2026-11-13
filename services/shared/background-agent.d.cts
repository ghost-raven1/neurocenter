export interface IBackgroundAgentCheck {
    command: string;
    args: string[];
}
export type TBackgroundAgentMethod = 'bmad' | 'openspec' | 'combined';
export type TBackgroundAgentContextSource = 'project' | 'computer' | 'web';
export type IBackgroundAgentContext = Partial<Record<TBackgroundAgentContextSource, Record<string, unknown>>>;
export interface IBackgroundAgentPayload {
    protocol: 'background-agent-v1';
    workflowId: string;
    requestId: string;
    projectId: string;
    method: TBackgroundAgentMethod;
    methodVersion: string;
    instruction: string;
    checks: IBackgroundAgentCheck[];
    context?: IBackgroundAgentContext;
    deadlineAt: string;
    runtime: 'opencode';
}
export const BACKGROUND_AGENT_PROTOCOL: 'background-agent-v1';
export const BACKGROUND_AGENT_JOB: 'run-background-agent';
export const BACKGROUND_AGENT_RUNTIME: 'opencode';
export const BACKGROUND_AGENT_CONTEXT_SOURCES: readonly TBackgroundAgentContextSource[];
export function normalizeBackgroundAgentContext(value: unknown): IBackgroundAgentContext | undefined;
export function normalizeBackgroundAgentPayload(value: unknown): IBackgroundAgentPayload;
export function backgroundAgentDigest(payload: unknown): string;
