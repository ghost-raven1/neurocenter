import type { ITextKnowledgeLimits } from './project-text-knowledge.cjs';
import type { IGgufImportPolicy } from './gguf-import-policy.cjs';
export interface IRuntimeLimitPolicy {
    textKnowledge: Readonly<ITextKnowledgeLimits>;
    ggufImport: Readonly<IGgufImportPolicy>;
}
export interface IRuntimeLimitView {
    revision: number;
    policy: Readonly<IRuntimeLimitPolicy>;
    ceilings: Readonly<IRuntimeLimitPolicy>;
    updatedAt: string | null;
}
export interface IRuntimeLimitAdminView extends IRuntimeLimitView {
    configurationEnabled: boolean;
}
export interface IRuntimeLimitInput {
    expectedRevision: number;
    requestKey: string;
    policy: IRuntimeLimitPolicy;
}
export interface IRuntimeLimitReceipt {
    requestKey: string;
    requestHash: string;
    revision: number;
    policy: Readonly<IRuntimeLimitPolicy>;
    acceptedAt: string;
}
export const RUNTIME_LIMIT_CEILINGS: Readonly<IRuntimeLimitPolicy>;
export const DEFAULT_RUNTIME_LIMIT_POLICY: Readonly<IRuntimeLimitPolicy>;
export function runtimeLimitPolicy(value: unknown): Readonly<IRuntimeLimitPolicy>;
export function runtimeLimitInput(value: unknown): IRuntimeLimitInput;
