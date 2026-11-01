import type { IChatMessage } from './chat.interfaces';
import type { IChatContextSettings } from './chat-context';
import type { TFeatureFlagKey } from '../../../shared/feature-flags.cjs';
import type { PoolClient } from 'pg';
import type { ITextAdmission } from '../../../shared/project-text-knowledge.cjs';

export interface IChatProjectSource {
    id: string;
    path: string;
    title?: string;
    startLine?: number;
    endLine?: number;
    score: number;
    excerpt: string;
}
export interface IChatProjectEvidence {
    status: 'none' | 'metadata' | 'ready' | 'empty' | 'unavailable';
    project?: { id: string; name: string; state: string; headRevision: number };
    generation?: string;
    snapshot?: string;
    sources: IChatProjectSource[];
    message?: string;
    mode?: 'text';
    textRevision?: number;
    corpusHash?: string;
    textAdmission?: ITextAdmission;
}
export interface IPreparedProjectContext {
    messages: IChatMessage[];
    evidence: IChatProjectEvidence;
    requiredFeatures: readonly TFeatureFlagKey[];
    /** Identity and access remain checked after a paid result; feature admission only precedes a new dispatch. */
    assertCurrent(db?: Pick<PoolClient, 'query'>): Promise<void>;
    beforeInference(): Promise<void>;
    fit(
        history: IChatMessage[],
        settings: IChatContextSettings,
        limits?: IProjectContextFit,
    ): { messages: IChatMessage[]; evidence: IChatProjectEvidence };
}
/** Internal consumers may project optional source text and impose their smaller prompt envelope before fitting. */
export interface IProjectContextFit {
    maxBytes?: number;
    projectSource?: (source: IChatProjectSource) => IChatProjectSource | null;
}
export interface IProjectContextCapture {
    identity: string;
    evidence: IChatProjectEvidence;
    searchEnabled: boolean;
}
