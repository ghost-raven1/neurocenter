import type {TextKnowledgeLimits} from './project-text-knowledge.cjs';
import type {GgufImportPolicy} from './gguf-import-policy.cjs';
export interface RuntimeLimitPolicy {textKnowledge:Readonly<TextKnowledgeLimits>;ggufImport:Readonly<GgufImportPolicy>;}
export interface RuntimeLimitView {revision:number;policy:Readonly<RuntimeLimitPolicy>;ceilings:Readonly<RuntimeLimitPolicy>;updatedAt:string|null;}
export interface RuntimeLimitAdminView extends RuntimeLimitView {configurationEnabled:boolean;}
export interface RuntimeLimitInput {expectedRevision:number;requestKey:string;policy:RuntimeLimitPolicy;}
export interface RuntimeLimitReceipt {requestKey:string;requestHash:string;revision:number;policy:Readonly<RuntimeLimitPolicy>;acceptedAt:string;}
export const RUNTIME_LIMIT_CEILINGS:Readonly<RuntimeLimitPolicy>;
export const DEFAULT_RUNTIME_LIMIT_POLICY:Readonly<RuntimeLimitPolicy>;
export function runtimeLimitPolicy(value:unknown):Readonly<RuntimeLimitPolicy>;
export function runtimeLimitInput(value:unknown):RuntimeLimitInput;
