import type { ChatMessage } from './chat.types';
import type { IChatContextSettings } from './chat-context';
import type { FeatureFlagKey } from '../../../shared/feature-flags.cjs';
import type {PoolClient} from 'pg';
import type {TextAdmission} from '../../../shared/project-text-knowledge.cjs';

export interface ChatProjectSource {
    id: string; path: string; title?: string; startLine?: number; endLine?: number; score: number; excerpt: string;
}
export interface ChatProjectEvidence {
    status: 'none' | 'metadata' | 'ready' | 'empty' | 'unavailable';
    project?: { id: string; name: string; state: string; headRevision: number };
    generation?: string; snapshot?: string; sources: ChatProjectSource[]; message?: string;
    mode?:'text';textRevision?:number;corpusHash?:string;textAdmission?:TextAdmission;
}
export interface PreparedProjectContext {
    messages: ChatMessage[]; evidence: ChatProjectEvidence;
    requiredFeatures: readonly FeatureFlagKey[];
    /** Identity and access remain checked after a paid result; feature admission only precedes a new dispatch. */
    assertCurrent(db?:Pick<PoolClient,'query'>): Promise<void>;
    beforeInference(): Promise<void>;
    fit(history: ChatMessage[], settings: IChatContextSettings, limits?: ProjectContextFit): { messages: ChatMessage[]; evidence: ChatProjectEvidence };
}
/** Internal consumers may project optional source text and impose their smaller prompt envelope before fitting. */
export interface ProjectContextFit { maxBytes?: number; projectSource?: (source: ChatProjectSource) => ChatProjectSource | null; }
export interface ProjectContextCapture { identity: string; evidence: ChatProjectEvidence; searchEnabled: boolean; }
