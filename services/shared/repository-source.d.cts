import type {RuntimeAdapter, RuntimeSource, RuntimeTarget} from './tool-runtime-source.cjs';
export interface RepositoryInput {type:'repository';url:string;ref?:string;subdirectory?:string;entrypoint?:string}
export interface RepositorySource {type:'repository';url:string;commit:string;subdirectory?:string;entrypoint:string;runtimeSource?:RuntimeSource;manifestSha256?:string}
export interface RepositoryManifest {schemaVersion:1;name?:string;description?:string;source:RuntimeSource}
export interface ParsedRepository {url:string;owner:string;repository:string;ref?:string;subdirectory?:string}
export interface ResolvedRepository {url:string;commit:string;ref:string;subdirectory?:string;entrypoint:string;candidates:string[];name:string;description:string;recommendedKind?:'mcp'|'plugin';adapter?:RuntimeAdapter;supportedTargets?:RuntimeTarget[];runtimeSource?:RuntimeSource;manifestSha256?:string}
export function parseRepositoryUrl(url:unknown,options?:{ref?:string;subdirectory?:string}):ParsedRepository;
export function validateRepositorySource(value:unknown,options?:{pinned?:true}):RepositorySource;
export function validateRepositorySource(value:unknown,options:{pinned:false}):RepositoryInput;
export function validateRepositoryManifest(value:Buffer|string):RepositoryManifest;
export const normalizeRepositorySource:typeof validateRepositorySource;
export function resolveRepositorySource(input:Omit<RepositoryInput,'type'>|RepositoryInput,options?:{fetch?:typeof fetch;metadata?:boolean}):Promise<ResolvedRepository>;
