import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const source = import.meta.url.endsWith('.ts') ? '../../../../../services/shared/rag-index-contract.cjs' : '../../shared/rag-index-contract.cjs';
const shared = createRequire(import.meta.url)(fileURLToPath(new URL(source, import.meta.url))) as typeof import('../../../../../services/shared/rag-index-contract.cjs');
export const { FINGERPRINT_VERSION, normalizeIndexProfile, normalizeChunkRow, rowFingerprint, indexSnapshotHash, embeddingSignature, managedEmbeddingConfiguration, ragRequestHash } = shared;
export type { IIndexProfile, ICanonicalRagRow } from '../../../../../services/shared/rag-index-contract.cjs';
