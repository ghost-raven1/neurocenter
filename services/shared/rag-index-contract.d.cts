export interface IIndexProfile {provider:string;model:string;dimension:number;}
export interface ICanonicalRagRow {
 id:string;filePath:string;content:string;description:string|null;startLine:number|null;endLine:number|null;
 language:string|null;kind:string;role:string|null;quirkType:string|null;tags:string|null;embedding:number[]|null;
}
export const FINGERPRINT_VERSION:1;
export function normalizeIndexProfile(value:unknown):IIndexProfile|null;
export function normalizeChunkRow(value:unknown):ICanonicalRagRow;
export function rowFingerprint(value:unknown):string;
export function indexSnapshotHash(profile:unknown,fingerprints:Record<string,string>):string;
export function embeddingSignature(profile:unknown,baseUrl?:unknown):string;
export function managedEmbeddingConfiguration(value?:{provider?:string;model?:string;baseUrl?:string;vectorDimension?:number}):{provider:string;model:string;baseUrl?:string;vectorDimension?:number};
/** SHA-256 canonical JSON для durable write idempotency, одинаковый до и после JSONB. */
export function ragRequestHash(value:unknown):string;
