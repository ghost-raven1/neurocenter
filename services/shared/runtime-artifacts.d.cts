export interface RuntimeArtifact {target:string;sha256:string;compressedBytes:number;unpackedBytes:number;filesCount:number;entrypoint:string;executable?:boolean}
export interface RuntimeArtifactEntry {path:string;size:number;sha256:string;executable:boolean}
export const TARGETS:string[];
export const LIMITS:{compressedBytes:number;unpackedBytes:number;filesCount:number;cacheBytes:number};
export function portablePath(value:unknown):boolean;
export function normalizeRuntimeArtifacts(value:unknown):RuntimeArtifact[];
/** Плагин допускает только импортируемую JS-точку входа. */
export function validateRuntimeArtifactEntrypoints(kind:string,artifacts:RuntimeArtifact[]):void;
export function inspectRuntimeArchive(filename:string,descriptor:RuntimeArtifact,options?:{destination?:string}):Promise<RuntimeArtifactEntry[]>;
