export interface CatalogRebuildRequest {schemaVersion:1;requestId:string;sourceRevision:string;requestedAt:string}
export function parseCatalogRebuildRequest(value:unknown):CatalogRebuildRequest;
export function makeCatalogRebuildRequest(sourceRevision:string):CatalogRebuildRequest;
export function catalogRebuildRequestKey(requestId:string,component:string):string;
