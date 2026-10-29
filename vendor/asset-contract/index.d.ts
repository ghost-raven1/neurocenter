export type AssetKind = 'mcp' | 'plugin' | 'skill' | 'model' | 'bridge' | 'agent';
export interface RuntimeArtifact {
  target: 'darwin-arm64'|'darwin-x64'|'linux-arm64-glibc'|'linux-x64-glibc'|'linux-arm64-musl'|'linux-x64-musl'|'win32-arm64'|'win32-x64';
  sha256: string; compressedBytes: number; unpackedBytes: number; filesCount: number; entrypoint: string; executable?: boolean;
}
export interface Dependency { id: string; version: string; sha256: string }
export type AssetSource = {type:'git';repository:string;commit:string;path?:string}
  | {type:'npm';name:string;version:string;integrity?:string}
  | {type:'release';repository:string;tag:string}
  | {type:'archive';sha256:string;bytes:number};
export interface AssetBase {
  schemaVersion: 1; id: string; kind: AssetKind; version: string; source: AssetSource;
  license: {spdx:string;url?:string};
  /** Consumer capability family; native inline packages may serialize as v4, runtime packages as v5. */
  compatibility: {packageFormat?:5;bridgeProtocol?:2};
  dependencies?: Dependency[]; recipe?: {path:string;sha256:string};
}
/** Native publication; existing app validator is required before storing or building package format 5. */
export interface ToolAsset extends AssetBase {
  kind: 'mcp'|'plugin';
  card: {name:string;kind:'mcp'|'plugin';description:string;revision:string;version?:1;files:unknown[];config:Record<string,unknown>;[key:string]:unknown};
  delivery: {type:'runtime-artifacts';artifacts:Array<{url?:string;descriptor:RuntimeArtifact}>};
}
export interface SkillAsset extends AssetBase {
  kind:'skill'; card:{path:'common';slug:string;name:string;body:string;meta:Record<string,unknown>;resources?:unknown[]}; delivery:{type:'inline'};
}
export interface ModelAsset extends AssetBase {
  kind:'model'; card:{id:string;name:string;descriptor:Record<string,unknown>};
  delivery:{type:'model-bundle';lock:Record<string,unknown>;bundle:Record<string,unknown>}|{type:'remote-api'};
}
export interface BridgeAsset extends AssetBase {
  kind:'bridge';card:{name:string;description:string;tags?:string[]};
  delivery:{type:'bridge-release';release:{schemaVersion:1;version:string;buildId:string;release:string;artifacts:Array<{file:string;url:string;metadata:Record<string,unknown>}>}};
}
export interface AgentDefinition {
  description:string;prompt:string;mode:'primary'|'subagent'|'all';model?:string;temperature?:number;topP?:number;steps?:number;
  permission:Partial<Record<'read'|'edit'|'bash'|'glob'|'grep'|'list'|'task'|'external_directory'|'todowrite'|'question'|'webfetch'|'websearch'|'lsp'|'doom_loop'|'skill','allow'|'ask'|'deny'>>;
}
export interface AgentAsset extends AssetBase {
  kind:'agent';card:{id:string;slug:string;name:string;definition:AgentDefinition};delivery:{type:'inline'};
}
export type AssetDescriptor=ToolAsset|SkillAsset|ModelAsset|BridgeAsset|AgentAsset;
export interface IndexEntry {id:string;kind:AssetKind;version:string;path:string;sha256:string;current:boolean}
export interface AssetIndex {schemaVersion:1;assets:IndexEntry[]}
export interface ResolvedAsset {asset:AssetDescriptor;sha256:string;path:string;current:boolean}
export interface LoadedRepository {index:AssetIndex;indexSha256:string;assets:ResolvedAsset[]}
/** SHA-256 of exact bytes, including any trailing newline. Dependencies and index use this same digest. */
export function assetDigest(bytes:Uint8Array|string):string;
export function serializeAsset(value:AssetDescriptor):string;
export function validateAsset(value:unknown):AssetDescriptor;
export function validateIndex(value:unknown):AssetIndex;
/** Previously published id/version bytes cannot change or disappear; changing the explicit current version is allowed. */
export function assertIndexEvolution(previous:AssetIndex,next:AssetIndex):void;
export function loadRepository(directory:string):Promise<LoadedRepository>;
/** IDs select current versions. Exact historical dependencies stay versioned; multiple versions never implicitly replace a source head. */
export function selectAssets(records:ResolvedAsset[],ids:string[]):ResolvedAsset[];
export interface NativeDependencyPin {kind:'mcp'|'plugin';id:string;version:number;manifest:string}
/** Produced by the server after resolving exact source assets to this installation's validated native packages. */
export interface ResolvedNativeDependency extends Dependency {kind:'mcp'|'plugin';native:NativeDependencyPin}
export interface DependencyContext {dependencies:ResolvedNativeDependency[]}
export function toToolPublication(asset:ToolAsset,context?:DependencyContext):ToolAsset['card'];
export function toSkillCreate(asset:SkillAsset,context?:DependencyContext):SkillAsset['card'];
/** Native projection only: first select the source closure and persist supply edges/immutable byte retention. */
export function toModelRecord(asset:ModelAsset):ModelAsset['card'];
/** Supply edges remain in provenance/retention; they never become MCP installation dependency pins. */
export function toBridgeRelease(asset:BridgeAsset):BridgeAsset['delivery']['release'];
/** Agents are validated as native OpenCode definitions before catalog persistence. */
export function toAgentRecord(asset:AgentAsset):AgentAsset['card'];
/** Producer boundary for existing packager output; rejects divergent duplicate runtime descriptors. */
export function createToolAsset(input:{id:string;version:string;source:AssetSource;license:AssetBase['license'];publication:ToolAsset['card'];artifacts:ToolAsset['delivery']['artifacts'];dependencies?:Dependency[];resolvedDependencies?:DependencyContext;recipe?:AssetBase['recipe']}):ToolAsset;
export interface DownloadArtifact {url?:string;sha256:string;bytes:number;filename:string;target?:string}
export function downloadArtifacts(asset:AssetDescriptor):DownloadArtifact[];
/** Server-supply only. Devices download through deployment-specific API Gateway endpoints. */
export function fetchArtifact(artifact:DownloadArtifact,filename:string,options?:{fetch?:typeof fetch;signal?:AbortSignal}):Promise<void>;
