import type {RuntimeSource,RuntimeTarget} from './tool-runtime-source.cjs';
export interface RepositoryRelease {tag:string;asset?:string;id?:number;assetId?:number;sha256?:string}
export interface ReleaseAsset {id:number;name:string;bytes:number;url:string;format:'tar.gz'|'zip'|'file';sha256?:string}
export interface ReleaseInspection {sha256:string;entrypoint:string;candidates:string[];name?:string;runtimeSource?:RuntimeSource;warnings?:string[];executableChoices?:Array<{entrypoint:string;runtimeEntrypoint?:string;adapter:string;targets:RuntimeTarget[]}>}
export type ReleaseInspector=(asset:ReleaseAsset,entrypoint?:string)=>Promise<ReleaseInspection>;
export function validateReleaseInput(value:unknown):RepositoryRelease;
