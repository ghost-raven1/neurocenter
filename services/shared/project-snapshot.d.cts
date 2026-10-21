export interface SnapshotChunk {sha256:string;size:number}
export interface SnapshotFile {path:string;size:number;sha256:string;chunks:SnapshotChunk[]}
export interface SnapshotTable {name:string;version:number;rows:number;schemaSha256:string}
export interface SnapshotManifest {format:'neurocenter.lancedb-snapshot';schemaVersion:1;sdkVersion:'0.29.0';tables:SnapshotTable[];files:SnapshotFile[]}
export const SNAPSHOT_CHUNK_BYTES:number;
export function snapshotCanonicalJson(value:unknown):string;
export function snapshotFilePath(value:unknown):value is string;
export function normalizeSnapshotManifest(input:unknown):SnapshotManifest;
export function snapshotManifestHash(input:unknown):string;
export function snapshotSchemaHash(schema:{fields:ReadonlyArray<{name:string;nullable:boolean;type:{toString():string}}> }):string;
