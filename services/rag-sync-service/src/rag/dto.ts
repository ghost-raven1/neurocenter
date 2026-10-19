/**
 * Модель входящих данных для dельта-apply.
 */
export interface ISyncChunk {
    id: string;
    filePath: string;
    content: string;
    description?: string | null;
    startLine?: number | null;
    endLine?: number | null;
    language?: string | null;
    kind?: string;
    role?: string | null;
    quirkType?: string | null;
    tags?: string | null;
    contentHash: string;
    embedding?: number[] | null;
}

export interface ISyncBody {
    projectKey: string;
    chunks?: ISyncChunk[];
    deletes?: string[];
}
