export interface SkillSourceFile {path:string;content:string;encoding?:'base64'}
export interface ParsedSkillSource {entrypoint:string;slug:string;name:string;description:string;body:string;meta:{description:string;tags:string[];mcp:[];plugins:[];specialization?:string};resources:SkillSourceFile[]}
export function parseSkillSource(files:SkillSourceFile[],overrides?:{name?:string;description?:string;entrypoint?:string;metadataOnly?:boolean},parseYaml?:(value:string)=>unknown):ParsedSkillSource;
export function skillSourceEntrypoints(files:SkillSourceFile[]):string[];
export function validateSkillLinks(content:string,paths:string[]):void;
