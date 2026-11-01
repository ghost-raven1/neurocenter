export interface ITextKnowledgeLimits {
    documents: number;
    fileBytes: number;
    batchBytes: number;
    pathBytes: number;
    queryBytes: number;
    sources: number;
    excerptBytes: number;
}
export const TEXT_KNOWLEDGE_LIMITS: Readonly<ITextKnowledgeLimits>;
export const TEXT_KNOWLEDGE_CEILINGS: Readonly<ITextKnowledgeLimits>;
export interface ITextAdmission {
    revision: number;
    limits: Readonly<ITextKnowledgeLimits>;
}
export interface ITextDocument {
    path: string;
    content: string;
}
export interface ITextUpload {
    requestKey: string;
    expectedRevision: number;
    documents: ITextDocument[];
}
export interface ITextSearch {
    query: string;
    revision?: number;
}
export interface ITextContext {
    mode: 'text';
    revision: number;
    corpusHash: string;
    query: string;
}
export interface ITextCorpusState {
    mode: 'text';
    projectId: string;
    revision: number;
    corpusHash: string;
    documentCount: number;
    bytes: number;
    updatedAt: string | null;
}
export interface ITextUploadReceipt extends ITextCorpusState {
    requestKey: string;
    requestHash: string;
    acceptedAt: string;
    admission?: ITextAdmission;
}
export interface ITextSource {
    id: string;
    path: string;
    startLine: number;
    endLine: number;
    excerpt: string;
    score: number;
}
export interface ITextSearchResult {
    mode: 'text';
    projectId: string;
    revision: number;
    corpusHash: string;
    sources: ITextSource[];
    admission?: ITextAdmission;
}
export function textKnowledgeLimits(value?: unknown): Readonly<ITextKnowledgeLimits>;
export function textKnowledgeAdmission(value: unknown): ITextAdmission;
export function normalizeTextUpload(value: unknown, policy?: Readonly<ITextKnowledgeLimits>): ITextUpload;
export function normalizeTextSearch(value: unknown, policy?: Readonly<ITextKnowledgeLimits>): ITextSearch;
export function normalizeTextContext(value: unknown, policy?: Readonly<ITextKnowledgeLimits>): ITextContext;
export function textUploadCanonical(value: unknown): string;
export function textBytes(value: string): number;
