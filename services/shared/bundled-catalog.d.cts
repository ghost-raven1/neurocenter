export interface BundledBuildSource {type:'bundled';id:string;revision:string}
export interface BundledCatalogPlan {id:string;kind:'mcp'|'plugin'|'model'|'bridge';name:string;description:string;sourceRevision:string;metadataSha256?:string;revision:string;delivery:{type:string;recipe?:string;automatic?:boolean}}
export interface BundledCatalogFile {path:string;sha256:string;bytes:number}
export interface BundledRecipe {schemaVersion:1;key:string;kind:'mcp'|'plugin';name:string;description:string;revision:string;tags?:string[];targets?:string[];source:{type:string;directory?:string;entrypoint?:string;adapter?:string};producer?:{schemaVersion:1;id:string;revision:string;producerSha256:string};[key:string]:unknown}
export function validateBundledBuildSource(value:unknown):BundledBuildSource;
export function readBundledCatalog(root?:string):Promise<{pin:import('./asset-source-client.cjs').IAssetSourcePin;revision:string;producerSha256:string;manifest:{history:{repository:string};files:BundledCatalogFile[]};plans:BundledCatalogPlan[];historicalPins:import('./asset-source-client.cjs').IAssetSourcePin[];metadata(sha:string,maximum:number):Promise<Buffer|undefined>;read(path:string):Promise<Buffer>}>;
export function bundledBuildRecipe(value:unknown,root?:string):Promise<{recipe:BundledRecipe;plan:BundledCatalogPlan;recipePath:string;bundle:Awaited<ReturnType<typeof readBundledCatalog>>}>;
export function checkedFile(root:string,path:string,sha256:string,maximum:number):Promise<Buffer>;
export function readBundledComponent(name:string,root?:string):Promise<{provenance:{schemaVersion:1;repository:string;commit:string;license:string|null;files:BundledCatalogFile[]};files:Map<string,Buffer>}>;
export function verifyBundledProducer(sha256:string,root?:string):Promise<{schemaVersion:1;files:BundledCatalogFile[]}>;
