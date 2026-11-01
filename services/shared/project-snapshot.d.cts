export interface ISnapshotChunk {
    sha256: string;
    size: number;
}
export interface ISnapshotFile {
    path: string;
    size: number;
    sha256: string;
    chunks: ISnapshotChunk[];
}
export interface ISnapshotTable {
    name: string;
    version: number;
    rows: number;
    schemaSha256: string;
}
export interface ISnapshotManifest {
    format: 'neurocenter.lancedb-snapshot';
    schemaVersion: 1;
    sdkVersion: '0.29.0';
    tables: ISnapshotTable[];
    files: ISnapshotFile[];
}
export const SNAPSHOT_CHUNK_BYTES: number;
export function snapshotCanonicalJson(value: unknown): string;
export function snapshotFilePath(value: unknown): value is string;
export function normalizeSnapshotManifest(input: unknown): ISnapshotManifest;
export function snapshotManifestHash(input: unknown): string;
export function snapshotSchemaHash(schema: {
    fields: ReadonlyArray<{ name: string; nullable: boolean; type: { toString(): string } }>;
}): string;
