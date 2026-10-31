import type { FeatureFlagKey } from '../../../shared/feature-flags.cjs';
export const CHAT_SEARCH_FEATURES: FeatureFlagKey[] = ['system_indexer', 'project_chat', 'rag_sync', 'model_hosting'];
export const CHAT_SEARCH_CHUNK = 2048,
    CHAT_SEARCH_SCAN_CAP = 10000;
export interface ChatSearchInput {
    requestKey: string;
    modelId: string;
    expectedModelPin: string;
    consent: true;
    roomId?: string;
    limit: number;
    query?: string;
}
export interface ChatSearchHit {
    messageId: string;
    roomId: string;
    roomTitle: string;
    revision: string;
    chunk: number;
    score: number;
    content: string;
    position: string;
    authorName: string | null;
}
export interface ChatSearchStoredHit {
    messageId: string;
    revision: string;
    chunk: number;
    score: number;
}
export interface ChatSearchJob {
    id: string;
    projectId: string;
    kind: 'index' | 'search';
    state: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
    modelId: string;
    modelPin: string;
    indexedChunks: number;
    hasMore: boolean;
    error: string | null;
    results?: ChatSearchHit[];
}
export interface ChatSearchJobRow {
    id: string;
    project_id: string;
    actor: string;
    active_role: string;
    request_key: string;
    request_hash: string;
    kind: 'index' | 'search';
    state: ChatSearchJob['state'];
    model_id: string;
    model_pin: string;
    dimension: number;
    deadline: Date | string;
    result: { indexedChunks?: number; hasMore?: boolean; hits?: ChatSearchStoredHit[] };
    error: string | null;
}
export interface ChatSearchSource {
    id: string;
    room_id: string;
    revision: string;
    content: string;
    position: string;
    room_title: string;
    author_name: string | null;
    chunks: number[];
}
