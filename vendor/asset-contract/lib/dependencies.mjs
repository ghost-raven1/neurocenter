import {object,sha,positive} from './validation.mjs';

/** Deployment UUIDs and native manifests are derived after ingestion, never published as portable source pins. */
export function assertPortableCardDependencies(value) {
  if(value!==undefined&&(!Array.isArray(value)||value.length))throw new Error('Public card cannot contain deployment-native dependency IDs; use portable asset.dependencies');
}
export function nativePins(asset,context) {
  const source=asset.dependencies||[];
  if(!context) {if(source.length)throw new Error('Resolve portable dependencies to validated native package pins before publishing');return [];}
  object(context,['dependencies'],'Dependency context');
  if(!Array.isArray(context.dependencies)||context.dependencies.length!==source.length)throw new Error('Dependency context must cover exactly the portable pins');
  const seen=new Set(),nativeIds=new Set();
  const pins=context.dependencies.map(item=>{
    object(item,['id','version','sha256','kind','native'],'Resolved dependency');
    const expected=source.find(pin=>pin.id===item.id);
    if(!expected||expected.version!==item.version||expected.sha256!==item.sha256||seen.has(item.id))throw new Error('Resolved dependency differs from portable pin');seen.add(item.id);
    if(!['mcp','plugin'].includes(item.kind))throw new Error('Infrastructure dependency cannot become an MCP/plugin package pin');
    object(item.native,['kind','id','version','manifest'],'Native dependency');
    const native=item.native;
    if(native.kind!==item.kind||typeof native.id!=='string'||!/^ai-plug-[a-z0-9][a-z0-9_-]{0,119}$/.test(native.id)||nativeIds.has(native.id))throw new Error('Invalid or duplicate native dependency identity');
    positive(native.version,'Native dependency version');sha(native.manifest);nativeIds.add(native.id);
    return structuredClone(native);
  });
  return pins.sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id));
}
