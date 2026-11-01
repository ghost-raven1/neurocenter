export interface IChatSearchInput {
    requestKey: string;
    modelId: string;
    expectedModelPin: string;
    consent: true;
    roomId?: string;
    limit: number;
    query?: string;
}

export interface IChatSearchHit {
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

export interface IChatSearchStoredHit {
    messageId: string;
    revision: string;
    chunk: number;
    score: number;
}

export interface IChatSearchJob {
    id: string;
    projectId: string;
    kind: 'index' | 'search';
    state: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
    modelId: string;
    modelPin: string;
    indexedChunks: number;
    hasMore: boolean;
    error: string | null;
    results?: IChatSearchHit[];
}

export interface IChatSearchJobRow {
    id: string;
    project_id: string;
    actor: string;
    active_role: string;
    request_key: string;
    request_hash: string;
    kind: 'index' | 'search';
    state: IChatSearchJob['state'];
    model_id: string;
    model_pin: string;
    dimension: number;
    deadline: Date | string;
    result: { indexedChunks?: number; hasMore?: boolean; hits?: IChatSearchStoredHit[] };
    error: string | null;
}

export interface IChatSearchSource {
    id: string;
    room_id: string;
    revision: string;
    content: string;
    position: string;
    room_title: string;
    author_name: string | null;
    chunks: number[];
}
