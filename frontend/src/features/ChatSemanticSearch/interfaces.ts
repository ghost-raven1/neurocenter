export interface IChatSearchIntent {
    requestKey: string;
    modelId: string;
    expectedModelPin: string;
    consent: true;
    roomId?: string;
    limit?: number;
    query?: string;
}

export interface IChatSearchJob {
    id: string;
    projectId: string;
    kind: 'index' | 'search';
    state: string;
    modelId: string;
    modelPin: string;
    indexedChunks: number;
    hasMore?: boolean;
    error?: string;
    results?: Array<{
        messageId: string;
        roomId: string;
        roomTitle: string;
        revision: string | number;
        chunk: number;
        score: number;
        content: string;
        position: string;
        authorName: string;
    }>;
}
