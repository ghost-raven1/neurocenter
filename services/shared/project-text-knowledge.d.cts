export const TEXT_KNOWLEDGE_LIMITS:Readonly<{documents:16;fileBytes:number;batchBytes:number;pathBytes:512;queryBytes:2048;sources:6;excerptBytes:3072}>;
export interface TextDocument {path:string;content:string;}
export interface TextUpload {requestKey:string;expectedRevision:number;documents:TextDocument[];}
export interface TextSearch {query:string;revision?:number;}
export interface TextContext {mode:'text';revision:number;corpusHash:string;query:string;}
export interface TextCorpusState {mode:'text';projectId:string;revision:number;corpusHash:string;documentCount:number;bytes:number;updatedAt:string|null;}
export interface TextUploadReceipt extends TextCorpusState {requestKey:string;requestHash:string;acceptedAt:string;}
export interface TextSource {id:string;path:string;startLine:number;endLine:number;excerpt:string;score:number;}
export interface TextSearchResult {mode:'text';projectId:string;revision:number;corpusHash:string;sources:TextSource[];}
export function normalizeTextUpload(value:unknown):TextUpload;
export function normalizeTextSearch(value:unknown):TextSearch;
export function normalizeTextContext(value:unknown):TextContext;
export function textUploadCanonical(value:unknown):string;
export function textBytes(value:string):number;
