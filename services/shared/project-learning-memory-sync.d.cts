import type { ILearningContext, ILearningContextEntry } from './project-learning.cjs';
export const MEMORY_SYNC_JOB: 'sync-learning-memory';
export const MEMORY_SYNC_CAPABILITY: 'project-learning-memory-v1';
export const MEMORY_RECIPE: {
    schemaVersion: 1;
    package: '@modelcontextprotocol/server-memory';
    version: '1.0.0';
    projectionSchemaVersion: 1;
};
export const MEMORY_SYNC_LIMITS: Readonly<{
    entities: number;
    activeEntries: number;
    observationsPerEntity: number;
    ownedObservationBytes: number;
    planBytes: number;
    journalBytes: number;
    readResponseBytes: number;
    stepsPerJob: number;
    concurrency: 1;
}>;
export interface IMemorySyncPayload {
    schemaVersion: 1;
    projectId: string;
    bindingId: string;
    instanceId: string;
    assetId: string;
    version: number;
    manifest: string;
    learningRevision: number;
    learningDigest: string;
    mode: 'sync' | 'cleanup';
}
export interface IMemorySyncContext {
    schemaVersion: 1;
    payload: IMemorySyncPayload;
    context: ILearningContext;
    package: unknown;
}
export interface IMemoryEntity {
    name: string;
    entityType: string;
    observations: string[];
}
export interface IMemorySyncResult {
    schemaVersion: 1;
    protocol: typeof MEMORY_SYNC_CAPABILITY;
    projectId: string;
    bindingId: string;
    instanceId: string;
    assetId: string;
    manifest: string;
    learningDigest: string;
    mode: 'sync' | 'cleanup';
    status: 'complete' | 'partial';
    applied: number;
    removed: number;
    remaining: number;
    receiptDigest: string;
    code: 'none' | 'authorization' | 'conflict' | 'unavailable' | 'quota';
}
export function memoryDigest(value: unknown): string;
export function memoryNamespace(site: string, projectId: string): string;
export function memoryEntity(namespace: string, entry: ILearningContextEntry): IMemoryEntity;
export function memoryRecipeSupported(pkg: unknown): boolean;
export function normalizeMemorySyncPayload(value: unknown): IMemorySyncPayload;
export function normalizeMemorySyncContext(value: unknown): IMemorySyncContext;
export function normalizeMemorySyncResult(value: unknown, payload: IMemorySyncPayload): IMemorySyncResult;
