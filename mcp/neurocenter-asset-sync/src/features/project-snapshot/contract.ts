import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const source=import.meta.url.endsWith('.ts')?'../../../../../services/shared/project-snapshot.cjs':'../../shared/project-snapshot.cjs';
const shared=createRequire(import.meta.url)(fileURLToPath(new URL(source,import.meta.url))) as typeof import('../../../../../services/shared/project-snapshot.cjs');
export const {SNAPSHOT_CHUNK_BYTES,snapshotCanonicalJson,snapshotFilePath,normalizeSnapshotManifest,snapshotManifestHash,snapshotSchemaHash}=shared;
export type {SnapshotManifest,SnapshotFile,SnapshotTable,SnapshotChunk} from '../../../../../services/shared/project-snapshot.cjs';
