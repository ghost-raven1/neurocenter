'use strict';
const {isSourceEntrypoint}=require('./source-entrypoint.cjs');
const {portablePath}=require('./runtime-artifacts.cjs');
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const clean=value=>typeof value==='string'&&portablePath(value.replace(/^\.\//,''))&&isSourceEntrypoint(value)?value.replace(/^\.\//,''):undefined;
/** Node conditions describe alternatives for one export, not separate user commands. */
function rootExport(value,depth=0){
 if(typeof value==='string')return clean(value);
 if(!value||depth>4)return;
 if(Array.isArray(value)){for(const item of value.slice(0,16)){const result=rootExport(item,depth+1);if(result)return result;}return;}
 if(!object(value))return;
 if(Object.hasOwn(value,'.'))return rootExport(value['.'],depth+1);
 for(const key of ['node','import','default','require']){const result=rootExport(value[key],depth+1);if(result)return result;}
}
/** Only bin is executable evidence for an otherwise ordinary library package. */
function packageEntrypoints(metadata){
 const bins=typeof metadata.bin==='string'?[metadata.bin]:object(metadata.bin)?Object.values(metadata.bin):[];
 const executable=[...new Set(bins.map(clean).filter(Boolean))];
 const dependencies={...(object(metadata.dependencies)?metadata.dependencies:{}),...(object(metadata.peerDependencies)?metadata.peerDependencies:{}),...(object(metadata.devDependencies)?metadata.devDependencies:{})};
 const kind=dependencies['@opencode-ai/plugin']?'plugin':dependencies['@modelcontextprotocol/sdk']?'mcp':undefined;
 const fallback=[clean(metadata.module),clean(metadata.main),rootExport(metadata.exports),clean(metadata.source)].filter(Boolean);
 const candidates=executable.length?executable:[...new Set(fallback)].slice(0,1);
 return {candidates,runnableKinds:executable.length?['mcp']:kind?[kind]:[],...(kind?{recommendedKind:kind}:{})};
}
module.exports={packageEntrypoints};
