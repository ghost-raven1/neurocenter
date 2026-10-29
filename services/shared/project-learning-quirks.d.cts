export interface RagQuirk {id:string;content:string;quirkType?:string;tags:string[];confidence:number;lastObserved:string;sourceRef?:string}
export interface QuirkEntry {quirk:RagQuirk;recordSha256:string}
export interface QuirkSource {kind:'rag_quirk';trust:'reported';quirk:RagQuirk;recordSha256:string;fileSha256:string;assetId:string;assetKind:'mcp'|'plugin';version:number;manifest:string;configurationRevision:string|null}
export interface QuirksSnapshot {fileSha256:string;records:QuirkEntry[]}
export interface QuirksReceipt {schemaVersion:1;status:'complete'|'partial';sourceCount:number;imported:number;skipped:number;remaining:number;fileSha256:string;safeRetry:true}
export interface LearningQuirksLimits {bytes:number;totalBytes:number;records:number;recordBytes:number;contentBytes:number;importedExperiences:number;receiptBytes:number}
export const QUIRKS_LIMITS:Readonly<LearningQuirksLimits>;
export const QUIRKS_SOURCE_SHA256:string;
export const QUIRKS_SOURCE_SHA256S:ReadonlyArray<string>;
export function supportsLearningQuirks(pkg:unknown):boolean;
export function normalizeQuirksLimits(value?:unknown):LearningQuirksLimits;
export function parseQuirksJsonl(value:unknown,limits?:Partial<LearningQuirksLimits>):QuirksSnapshot;
export function preflightQuirkImport(snapshot:QuirksSnapshot,target:{projectId:string;instanceId:string},existingIds:string[],maximum?:number):{newCount:number;existingCount:number};
export function normalizeQuirkSource(value:unknown):QuirkSource;
export function quirkExperienceKey(projectId:string,instanceId:string,quirkId:string,recordSha256:string):string;
export function quirkReportedExperience(target:{projectId:string;instanceId:string},entry:QuirkEntry,source:Omit<QuirkSource,'kind'|'trust'|'quirk'|'recordSha256'>):import('./project-learning.cjs').LearningObservedExperienceInput;
export function normalizeQuirksReceipt(value:unknown):QuirksReceipt;
