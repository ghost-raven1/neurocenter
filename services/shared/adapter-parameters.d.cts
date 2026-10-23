export type AdapterJson = null|boolean|number|string|AdapterJson[]|{[key:string]:AdapterJson};
export type AdapterParameters = {[key:string]:AdapterJson};
export interface AdapterParameterDefinition {readonly id:string;readonly wirePath:readonly string[];readonly protectedKeys:readonly string[];readonly maximumBytes:number;readonly maximumDepth:number;readonly maximumNodes:number}
export const ADAPTER_PARAMETER_DEFINITIONS:Readonly<Record<'openai-chat-completions'|'openai-responses'|'ollama',AdapterParameterDefinition>>;
export function normalizeAdapterParameters(value:unknown,definition?:AdapterParameterDefinition):AdapterParameters;
export function applyAdapterParameters(body:Record<string,unknown>,parameters:unknown,definition:AdapterParameterDefinition):Record<string,unknown>;
export interface AdapterParameterIssue {name:string;type:string}
export function adapterParameterIssues(value:unknown,known:readonly string[]):AdapterParameterIssue[];
