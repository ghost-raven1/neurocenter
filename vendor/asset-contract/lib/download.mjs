import {open,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateAsset} from './asset.mjs';
import {object,sha,positive,safePath,releaseUrl} from './validation.mjs';

/** Upstream URLs are server-supply inputs. Devices receive authorized API Gateway URLs from Neurocenter. */
export function downloadArtifacts(asset) {
  validateAsset(asset);
  if(['mcp','plugin'].includes(asset.kind))return asset.delivery.artifacts.map(({url,descriptor})=>({...(url===undefined?{}:{url}),sha256:descriptor.sha256,bytes:descriptor.compressedBytes,filename:descriptor.sha256+'.tar.gz',target:descriptor.target}));
  if(asset.kind==='bridge')return asset.delivery.release.artifacts.map(({file,url,metadata})=>({url,sha256:metadata.sha256,bytes:metadata.bytes,filename:file,target:metadata.target}));
  if(asset.kind==='model'&&asset.delivery.type==='model-bundle')return asset.delivery.bundle.files.flatMap(file=>(file.parts||[]).map(part=>({url:asset.delivery.bundle.releaseBaseUrl+'/'+part.name,sha256:part.sha256,bytes:part.size,filename:part.name})));
  return [];
}
function redirectUrl(value) {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname))throw new Error('Unsafe artifact redirect');
  return url.href;
}
/** Fetch into a new caller-owned staging file. Never execute or extract downloaded content. */
export async function fetchArtifact(artifact,filename,{fetch:request=globalThis.fetch,signal:cancellation}={}) {
  object(artifact,['url','sha256','bytes','filename','target'],'Download artifact');
  if(artifact.url===undefined)throw new Error('Content-only artifact requires an already verified local blob; no network transport is declared');
  releaseUrl(artifact.url);sha(artifact.sha256);positive(artifact.bytes,'Artifact bytes');safePath(artifact.filename);
  const signal=AbortSignal.any([AbortSignal.timeout(10*60*1000),...(cancellation?[cancellation]:[])]);
  signal.throwIfAborted();let response,url=artifact.url;
  for(let hop=0;hop<5;hop++) {
    response=await request(url,{redirect:'manual',signal});
    if(![301,302,303,307,308].includes(response.status))break;
    const location=response.headers.get('location');await response.body?.cancel();
    if(!location||hop===4)throw new Error('Artifact redirect limit exceeded');url=redirectUrl(new URL(location,url).href);
  }
  if(!response?.ok||!response.body) {await response?.body?.cancel();throw new Error(`Artifact HTTP ${response?.status||0}`);}
  const length=response.headers.get('content-length');
  if(length!==null&&length!==String(artifact.bytes)){await response.body.cancel();throw new Error('Artifact content length mismatch');}
  let handle,created=false;
  try {
    handle=await open(filename,'wx',0o600);created=true;const digest=createHash('sha256');let bytes=0;
    for await(const chunk of response.body) {
      signal.throwIfAborted();bytes+=chunk.length;if(bytes>artifact.bytes)throw new Error('Artifact exceeds pinned size');
      digest.update(chunk);await handle.writeFile(chunk);
    }
    signal.throwIfAborted();
    if(bytes!==artifact.bytes||digest.digest('hex')!==artifact.sha256)throw new Error('Artifact size or SHA-256 mismatch');
    await handle.sync();await handle.close();handle=undefined;
  }catch(error) {
    await handle?.close().catch(()=>{});if(created)await unlink(filename).catch(()=>{});await response.body.cancel().catch(()=>{});throw error;
  }
}
