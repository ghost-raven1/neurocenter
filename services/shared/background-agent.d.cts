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
/** job-machine kind для строки фоновой задачи на сервере (FR-305, agt-07 Phase B) — отличается от BACKGROUND_AGENT_JOB. */
export const BACKGROUND_AGENT_WORKFLOW_JOB: 'run-background-agent-workflow';
/** OQ-2: единственная версия OpenCode — операторский пакет обязан нести bin/opencode-probe именно этой версии. */
export const BACKGROUND_AGENT_OPENCODE_VERSION: '1.14.48';
export const BACKGROUND_AGENT_RUNTIME: 'opencode';
export const BACKGROUND_AGENT_CONTEXT_SOURCES: readonly TBackgroundAgentContextSource[];
export function normalizeBackgroundAgentContext(value: unknown): IBackgroundAgentContext | undefined;
export function normalizeBackgroundAgentPayload(value: unknown): IBackgroundAgentPayload;
export function backgroundAgentDigest(payload: unknown): string;
