export const ASSET_IMPORT_MAX_ITEMS=50;
export type TSourceAssetKind='mcp'|'plugin'|'skill'|'model'|'bridge'|'agent';
export interface ISourceAsset {id:string;kind:TSourceAssetKind;name:string;description?:string;version:string;sha256:string;license:string;dependencies:Array<{id:string;version:string}>;supply?:{ready:boolean;missingFiles:number;missingBytes:number};imported?:{id:string;name?:string;version:number;originVersion:string;updateAvailable:boolean;archived?:boolean;unavailable?:boolean}}
export interface IBundledSourcePlan {id:string;kind:'mcp'|'plugin'|'model'|'bridge';name:string;description:string;sourceRevision:string;revision:string;delivery:string;catalogReady?:boolean;imported?:ISourceAsset['imported']}
export interface ICatalogRebuildItem {id:string;name:string;state:'ready'|'pending'|'attention'|'archive-required';message:string;operationId?:string;catalogId?:string}
export interface ICatalogRebuild {requestId:string;sourceRevision:string;requestedAt:string;updatedAt:string;state:'preparing'|'ready'|'attention';items:ICatalogRebuildItem[];message?:string}
export interface ISourceList {source:{repository:string;mode?:'online'|'offline'|'bundled';archiveSha256?:string;commit?:string;checkedAt?:string;verified:boolean;error?:string;lastAttemptAt?:string};assets:ISourceAsset[];localAssets?:ISourceAsset[];sourcePlans?:IBundledSourcePlan[];rebuild?:ICatalogRebuild}
/** rejected подтверждает отказ свежего POST до создания job; отсутствие признака сохраняет неизвестный исход. */
export interface IImportIntent {requestKey:string;commit:string;ids:string[];jobId?:string;rejected?:true}
export interface IAssetImport {id:string;planDigest:string;state:string;message:string;cancelRequested?:boolean;items:Array<{id:string;kind:TSourceAssetKind;name:string;catalogName?:string;version:string;current:boolean;action:string;state:string;reason?:string;message?:string;replacement?:{id:string;version:number;hash:string}}> }
export const activeImport=(state:string):boolean=>['QUEUED','RUNNING'].includes(state);
export function readImportIntent(value:string|null):IImportIntent|undefined {
 try{const parsed=JSON.parse(value??'null') as IImportIntent;
  if(parsed&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(parsed.requestKey)&&/^(?:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/.test(parsed.commit)
   &&Array.isArray(parsed.ids)&&parsed.ids.length>0&&parsed.ids.length<=ASSET_IMPORT_MAX_ITEMS&&parsed.ids.every(id=>typeof id==='string')&&new Set(parsed.ids).size===parsed.ids.length
   &&(parsed.jobId===undefined||/^[a-f0-9-]{36}$/.test(parsed.jobId))){return {...parsed,rejected:parsed.rejected===true&&!parsed.jobId?true:undefined};}
 }catch{/* Неполный локальный черновик не становится запросом сервера. */}return undefined;
}
