import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import runtime from '../../services/shared/runtime-artifacts.cjs';
const {parse}=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url))('smol-toml');
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const publicDescription=value=>typeof value==='string'?value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,' ').trim().slice(0,2000).trim():undefined;

/** Public manifest text never changes the checked launch plan or evaluates upstream source. */
export async function payloadDescription(directory,choices){
 const cache=new Map();
 const read=async(relative,python=false)=>{
  if(!runtime.portablePath(relative))return;
  if(!cache.has(relative))cache.set(relative,(async()=>{
   const filename=path.join(directory,relative);let info;
   try{info=await fs.lstat(filename);}catch(error){if(error.code==='ENOENT')return;throw error;}
   const result={path:relative};
   if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>65536)return result;
   const bytes=await fs.readFile(filename),text=bytes.toString('utf8');
   if(bytes.includes(0)||!Buffer.from(text).equals(bytes))return result;
   let metadata;try{metadata=python?parse(text):JSON.parse(text);}catch{return result;}
   if(python)metadata=metadata?.project;
   if(!object(metadata)||python&&Array.isArray(metadata.dynamic)&&metadata.dynamic.includes('description'))return result;
   return {...result,description:publicDescription(metadata.description)};
  })());
  return cache.get(relative);
 };
 const metadata=await Promise.all(choices.map(async choice=>{
  if(choice.python){const root=choice.python.projectDirectory;return read(root==='.'?'pyproject.toml':root+'/pyproject.toml',true);}
  if(!runtime.portablePath(choice.entrypoint))return;
  const python=choice.adapter==='python',manifest=python?'pyproject.toml':'package.json';let root=path.posix.dirname(choice.entrypoint);
  for(;;){const value=await read(root==='.'?manifest:root+'/'+manifest,python);if(value||root==='.')return value;root=path.posix.dirname(root);}
 }));
 const first=metadata[0];
 return first?.description&&metadata.every(value=>value?.path===first.path&&value.description===first.description)?first.description:undefined;
}
