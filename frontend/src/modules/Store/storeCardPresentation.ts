import {packageRuntimeArtifacts} from '../../features/McpBridge/runtimeArtifacts';
import {packagingPlatformLabels} from './packaging/platformLabels';

export interface StoreSourceIdentity {label:string;href?:string}

/** Public source labels omit credentials, query strings and internal archive/build identifiers. */
export function storeCardSource(origin:string):StoreSourceIdentity|undefined{
 if(typeof origin!=='string'||origin.length>2048)return undefined;
 if(origin==='neurocenter:tool-builder'||/^neurocenter:recipe\/[a-z0-9][a-z0-9._-]{0,127}$/.test(origin))return {label:'Упакован в Нейроцентре'};
 if(origin==='neurocenter:catalog-plugins')return {label:'Нейроцентр'};
 if(!origin||origin!==origin.trim()||/[\\\x00-\x20\x7f]/.test(origin))return undefined;
 if(/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(origin.split(/[?#]/,1)[0]))return undefined;
 let url:URL;try{url=new URL(origin);}catch{return undefined;}
 if(url.protocol!=='https:'||url.username||url.password||url.port)return undefined;
 if(url.hostname==='github.com'){
  const match=/^\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_][a-z0-9._-]{0,99})\/?$/i.exec(url.pathname);
  if(!match)return undefined;const owner=match[1],repository=match[2].replace(/\.git$/i,'');
  return {label:'GitHub · '+owner+'/'+repository,href:'https://github.com/'+owner+'/'+repository};
 }
 if(url.hostname==='www.npmjs.com'||url.hostname==='npmjs.com'){
  const match=/^\/package\/((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)\/?$/.exec(url.pathname);
  if(match)return {label:'npm · '+match[1],href:'https://www.npmjs.com/package/'+match[1]};
 }
 return undefined;
}

/** Only explicit semantic release labels are shown; source/build hashes stay in detailed metadata. */
export function storeCardRevision(revision?:string|null):string|undefined{
 return revision&&revision.length<=80&&/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(revision)
  &&!/(?:^|[.+-])[a-f0-9]{16,}(?:$|[.+-])/i.test(revision)?revision:undefined;
}

/** Platform summaries use the same validated artifact inventory as installation approval. */
export function storeCardPlatforms(config?:Record<string,unknown>):{label:string;title:string}|undefined{
 const artifacts=packageRuntimeArtifacts({config:config??null});if(!artifacts.length)return undefined;
 const systems=[...new Set(artifacts.map(({target})=>target.startsWith('darwin-')?'macOS':target.startsWith('linux-')?'Linux':'Windows'))];
 return {label:systems.join(' · '),title:artifacts.map(({target})=>packagingPlatformLabels[target]).join(', ')};
}
