export interface TextKnowledgeLimits {documents:number;fileBytes:number;batchBytes:number;pathBytes:number;queryBytes:number;sources:number;excerptBytes:number;}
export const TEXT_KNOWLEDGE_LIMITS:Readonly<TextKnowledgeLimits>;
export const TEXT_KNOWLEDGE_CEILINGS:Readonly<TextKnowledgeLimits>;
export interface TextAdmission {revision:number;limits:Readonly<TextKnowledgeLimits>;}
export interface TextDocument {path:string;content:string;}
export interface TextUpload {requestKey:string;expectedRevision:number;documents:TextDocument[];}
export interface TextSearch {query:string;revision?:number;}
export interface TextContext {mode:'text';revision:number;corpusHash:string;query:string;}
export interface TextCorpusState {mode:'text';projectId:string;revision:number;corpusHash:string;documentCount:number;bytes:number;updatedAt:string|null;}
export interface TextUploadReceipt extends TextCorpusState {requestKey:string;requestHash:string;acceptedAt:string;admission?:TextAdmission;}
export interface TextSource {id:string;path:string;startLine:number;endLine:number;excerpt:string;score:number;}
export interface TextSearchResult {mode:'text';projectId:string;revision:number;corpusHash:string;sources:TextSource[];admission?:TextAdmission;}
export function textKnowledgeLimits(value?:unknown):Readonly<TextKnowledgeLimits>;
export function textKnowledgeAdmission(value:unknown):TextAdmission;
export function normalizeTextUpload(value:unknown,policy?:Readonly<TextKnowledgeLimits>):TextUpload;
export function normalizeTextSearch(value:unknown,policy?:Readonly<TextKnowledgeLimits>):TextSearch;
export function normalizeTextContext(value:unknown,policy?:Readonly<TextKnowledgeLimits>):TextContext;
export function textUploadCanonical(value:unknown):string;
export function textBytes(value:string):number;
