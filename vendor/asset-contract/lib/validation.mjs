import {createHash} from 'node:crypto';

export const KINDS = ['mcp','plugin','skill','model','bridge','agent'];
export const SHA = /^[a-f0-9]{64}$/;
export const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const mutable = /^(latest|main|master|head)$/i;

/** Reject unknown fields rather than silently changing the public contract. */
export function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label}: unexpected structure or field`);
  return value;
}
export function text(value, label, max=4096) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length>max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}: invalid text`);
  return value;
}
export function pin(value,label) {
  text(value,label,128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(value) || mutable.test(value)) throw new Error(`${label}: immutable version required`);
  return value;
}
export function sha(value,label='SHA-256') {if(typeof value!=='string'||!SHA.test(value)) throw new Error(`${label}: invalid digest`);return value;}
export function identifier(value) {return typeof value==='string'&&ID.test(value);}
export function positive(value,label) {if(!Number.isSafeInteger(value)||value<1)throw new Error(`${label}: positive integer required`);return value;}
export function safePath(value) {
  if(typeof value!=='string'||!value||Buffer.byteLength(value)>240||value.includes('\\')||value.startsWith('/')||value.split('/').some(part=>
    !part||part==='.'||part==='..'||/[<>:"|?*\x00-\x1f\x7f]/.test(part)||/[. ]$/.test(part)||/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) throw new Error('Unsafe relative path');
  return value;
}
export function https(value,label='URL') {
  let url;try{url=new URL(value);}catch{throw new Error(`${label}: HTTPS URL required`);}
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.search||value!==url.href)throw new Error(`${label}: canonical public HTTPS URL required`);
  return url;
}
export function repository(value) {
  const url=https(value,'Repository');
  if(url.hostname!=='github.com'||!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname)||url.pathname.endsWith('.git'))throw new Error('GitHub repository URL required without .git');
  return value;
}
export function releaseUrl(value) {
  const url=https(value,'Artifact URL');
  const match=url.pathname.match(/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/([A-Za-z0-9._+-]+)\/([^/]+)$/);
  if(url.hostname!=='github.com'||!match||mutable.test(match[1])||decodeURIComponent(match[2])!==match[2]||!ID.test(match[2]))throw new Error('Pinned GitHub release artifact URL required');
  return url;
}
export function stringList(value,label,max=20) {
  if(!Array.isArray(value)||value.length>max||new Set(value).size!==value.length)throw new Error(`${label}: unique list required`);
  value.forEach(item=>text(item,label,256));return value;
}
/** Hash exact descriptor bytes, including any newline; never hash a parsed object implicitly. */
export function assetDigest(bytes) {
  if(typeof bytes!=='string'&&!(bytes instanceof Uint8Array))throw new TypeError('assetDigest requires exact bytes');
  return createHash('sha256').update(bytes).digest('hex');
}
export function canonicalJson(value) {
  const visit=(item)=>{
    if(item===null||typeof item==='boolean'||typeof item==='string')return item;
    if(typeof item==='number'&&Number.isFinite(item))return item;
    if(Array.isArray(item))return Array.from(item,visit);
    if(item&&typeof item==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(item)))return Object.fromEntries(Object.keys(item).sort().map(key=>{
      if(['__proto__','prototype','constructor'].includes(key))throw new Error('Unsafe JSON key');return [key,visit(item[key])];
    }));
    throw new Error('JSON contains an unsupported value');
  };
  return JSON.stringify(visit(value),null,2)+'\n';
}
