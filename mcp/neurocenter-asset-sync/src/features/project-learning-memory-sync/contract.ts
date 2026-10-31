import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const source = import.meta.url.endsWith('.ts')
    ? '../../../../../services/shared/project-learning-memory-sync.cjs'
    : '../../shared/project-learning-memory-sync.cjs';
const contract = createRequire(import.meta.url)(
    fileURLToPath(new URL(source, import.meta.url)),
) as typeof import('../../../../../services/shared/project-learning-memory-sync.cjs');
export const {
    MEMORY_SYNC_JOB,
    MEMORY_SYNC_CAPABILITY,
    MEMORY_SYNC_LIMITS,
    memoryDigest,
    memoryNamespace,
    memoryEntity,
    memoryRecipeSupported,
    normalizeMemorySyncPayload,
    normalizeMemorySyncContext,
    normalizeMemorySyncResult,
} = contract;
export type {
    MemorySyncPayload,
    MemorySyncContext,
    MemorySyncResult,
    MemoryEntity,
} from '../../../../../services/shared/project-learning-memory-sync.cjs';
