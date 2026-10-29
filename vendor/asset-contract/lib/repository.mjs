import {lstat,open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {KINDS,identifier,object,pin,sha,safePath,assetDigest} from './validation.mjs';
import {validateAsset} from './asset.mjs';

/** Index hashes bind descriptor bytes, not a reformatted or normalized JSON object. */
export function validateIndex(value) {
  object(value,['schemaVersion','assets'],'Index');
  if(value.schemaVersion!==1||!Array.isArray(value.assets)||value.assets.length>1000)throw new Error('Unsupported asset index');
  const seen=new Set(),paths=new Set(),groups=new Map();
  for(const entry of value.assets) {
    object(entry,['id','kind','version','path','sha256','current'],'Index entry');
    if(!identifier(entry.id)||!KINDS.includes(entry.kind)||typeof entry.current!=='boolean')throw new Error('Invalid indexed asset or current flag');
    pin(entry.version,'Indexed version');sha(entry.sha256);safePath(entry.path);
    const key=entry.id+':'+entry.version;
    if(seen.has(key))throw new Error('Duplicate indexed asset version');
    if(entry.path!==`assets/${entry.id}/${entry.version}/asset.json`||paths.has(entry.path.toLowerCase()))throw new Error('Unsafe or duplicate descriptor path');
    const group=groups.get(entry.id)||{kind:entry.kind,current:0};
    if(group.kind!==entry.kind)throw new Error('One asset ID cannot change kind');
    group.current+=Number(entry.current);groups.set(entry.id,group);seen.add(key);paths.add(entry.path.toLowerCase());
  }
  if([...groups.values()].some(group=>group.current!==1))throw new Error('Each indexed asset requires exactly one current version');
  return value;
}
/** Retain published version identities across releases; a head change never rewrites an immutable version. */
export function assertIndexEvolution(previous,next) {
  validateIndex(previous);validateIndex(next);
  const current=new Map(next.assets.map(entry=>[entry.id+':'+entry.version,entry]));
  for(const entry of previous.assets) {
    const found=current.get(entry.id+':'+entry.version);
    if(!found)throw new Error('Published asset versions cannot disappear from the index');
    if(found.sha256!==entry.sha256||found.kind!==entry.kind)throw new Error('Published asset version bytes or kind changed');
  }
}
async function checkedBytes(root,relative,limit) {
  safePath(relative);let current=root;
  for(const [index,part]of relative.split('/').entries()) {
    current=path.join(current,part);const info=await lstat(current);
    const parent=index<relative.split('/').length-1;
    if(info.isSymbolicLink()||(parent?!info.isDirectory():!info.isFile()||info.nlink!==1||info.size>limit))throw new Error(`Unsafe repository file: ${relative}`);
  }
  const handle=await open(current,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=await handle.stat();
    if(!before.isFile()||before.nlink!==1||before.size>limit)throw new Error('Unsafe repository file');
    const bytes=await handle.readFile(),after=await handle.stat();
    if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length>limit||!Buffer.from(bytes.toString('utf8')).equals(bytes)
      ||await realpath(current)!==current)throw new Error('Repository file changed or is not UTF-8');
    return bytes;
  }finally{await handle.close();}
}
export async function loadRepository(directory) {
  const initial=await lstat(directory);if(!initial.isDirectory()||initial.isSymbolicLink())throw new Error('Repository must be an ordinary directory');
  const root=await realpath(directory),indexBytes=await checkedBytes(root,'index.json',1024**2),index=validateIndex(JSON.parse(indexBytes.toString('utf8'))),assets=[];
  for(const entry of index.assets) {
    const bytes=await checkedBytes(root,entry.path,16*1024**2);
    if(assetDigest(bytes)!==entry.sha256)throw new Error(`Descriptor SHA mismatch: ${entry.id}`);
    const asset=validateAsset(JSON.parse(bytes.toString('utf8')));
    if(asset.id!==entry.id||asset.kind!==entry.kind||asset.version!==entry.version)throw new Error('Index and descriptor identity mismatch');
    if(asset.recipe) {const recipe=await checkedBytes(root,asset.recipe.path,1024**2);if(assetDigest(recipe)!==asset.recipe.sha256)throw new Error('Recipe SHA mismatch');}
    assets.push({asset,sha256:entry.sha256,path:entry.path,current:entry.current});
  }
  return {index,indexSha256:assetDigest(indexBytes),assets};
}

/** Resolve an explicit selection atomically before fetching bytes or mutating any catalog. */
export function selectAssets(records,ids) {
  if(!Array.isArray(ids)||ids.length>1000||new Set(ids).size!==ids.length||ids.some(id=>!identifier(id)))throw new Error('Explicit unique asset IDs required');
  if(!Array.isArray(records)||records.length>1000)throw new Error('Resolved asset records required');
  const byVersion=new Map(),heads=new Map();for(const record of records) {
    object(record,['asset','sha256','path','current'],'Resolved asset');validateAsset(record.asset);sha(record.sha256);safePath(record.path);
    if(typeof record.current!=='boolean')throw new Error('Explicit current flag required');
    const key=record.asset.id+':'+record.asset.version;
    if(byVersion.has(key))throw new Error('Duplicate resolved asset version');byVersion.set(key,record);
    if(record.current) {if(heads.has(record.asset.id))throw new Error('Two current versions of one asset');heads.set(record.asset.id,record);}
  }
  const visiting=new Set(),done=new Set(),result=[];
  const visit=record=>{
    const key=record.asset.id+':'+record.asset.version;
    if(visiting.has(key))throw new Error(`Cyclic asset dependency: ${key}`);if(done.has(key))return;
    visiting.add(key);for(const dependency of record.asset.dependencies||[]) {
      const target=byVersion.get(dependency.id+':'+dependency.version);
      if(!target||target.asset.version!==dependency.version||target.sha256!==dependency.sha256)throw new Error(`Dependency pin mismatch: ${dependency.id}`);
      visit(target);
    }
    visiting.delete(key);done.add(key);result.push(record);
  };
  for(const id of ids) {const head=heads.get(id);if(!head)throw new Error(`Missing selected current asset: ${id}`);visit(head);}
  return result;
}
