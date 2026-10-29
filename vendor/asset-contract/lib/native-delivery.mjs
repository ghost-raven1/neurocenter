import {isDeepStrictEqual} from 'node:util';
import {object,text,pin,sha,positive,safePath,https,releaseUrl,stringList,assetDigest} from './validation.mjs';

/** Preserve native model locks and split bundle files; never reinterpret model weights as runtime TARs. */
export function validateModelDelivery(asset) {
  const card=object(asset.card,['id','name','descriptor'],'Model card');
  if(!/^model-[a-z0-9][a-z0-9-]{0,120}$/.test(card.id)||card.id!==asset.id)throw new Error('Model card ID mismatch');text(card.name,'Model name',128);
  const descriptor=object(card.descriptor,['description','capability','runtime','model','modelVersion','manifestSha256','dimension','verificationSha256','source'],'Model descriptor');
  if(asset.delivery?.type==='remote-api') {
    object(asset.delivery,['type'],'Remote model delivery');text(descriptor.description,'Model description',4000);text(descriptor.model,'Provider model ID',200);text(descriptor.modelVersion,'Provider model version',128);
    if(!['remote-openai','remote-ollama'].includes(descriptor.runtime)||!['embedding','vision','chat'].includes(descriptor.capability)
      ||!['custom','builtin'].includes(descriptor.source)||descriptor.manifestSha256!==null||descriptor.verificationSha256!==null||!(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/).test(descriptor.model)||descriptor.model.includes('://')
      ||!(descriptor.dimension===null||descriptor.capability==='embedding'&&Number.isSafeInteger(descriptor.dimension)&&descriptor.dimension>0&&descriptor.dimension<=16384))throw new Error('Remote model requires deployment configuration, not weight or verification claims');
    return;
  }
  text(descriptor.description,'Model description',4000);sha(descriptor.manifestSha256);
  if(descriptor.modelVersion!==undefined||descriptor.verificationSha256!==undefined&&descriptor.verificationSha256!==null)throw new Error('Managed model version is pinned by its weight manifest');
  if(descriptor.runtime!=='ollama'||!['embedding','vision','chat'].includes(descriptor.capability)||descriptor.source!=='builtin'
    ||!/^([a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/i.test(descriptor.model)
    ||!(descriptor.dimension===null||descriptor.capability==='embedding'&&Number.isSafeInteger(descriptor.dimension)&&descriptor.dimension>0&&descriptor.dimension<=16384))throw new Error('Unsupported native model descriptor');
  const delivery=object(asset.delivery,['type','lock','bundle'],'Model delivery');if(delivery.type!=='model-bundle')throw new Error('Model bundle required');
  const lock=object(delivery.lock,['schemaVersion','model','dimension','capability','registryManifestUrl','manifestSha256','manifest','image'],'Model lock');
  if(lock.schemaVersion!==1||lock.model!==descriptor.model||lock.manifestSha256!==descriptor.manifestSha256)throw new Error('Model lock differs from card');
  if(lock.dimension!==undefined&&lock.dimension!==descriptor.dimension||lock.capability!==undefined&&lock.capability!==descriptor.capability)throw new Error('Model capability or dimension differs from lock');
  https(lock.registryManifestUrl,'Registry manifest URL');
  if(typeof lock.image!=='string'||!/@sha256:[a-f0-9]{64}$/.test(lock.image))throw new Error('Pinned model runtime image required');
  const manifest=object(lock.manifest,['schemaVersion','mediaType','config','layers','runner','format'],'Ollama manifest');
  if(manifest.schemaVersion!==2||!Array.isArray(manifest.layers))throw new Error('Invalid model manifest');
  const expected=new Map();
  const [model,tag]=lock.model.split(':');
  expected.set(`models/manifests/registry.ollama.ai/${model.includes('/')?model:'library/'+model}/${tag}`,{sha256:lock.manifestSha256,manifest:true});
  for(const layer of [manifest.config,...manifest.layers]) {
    object(layer,['mediaType','digest','size','from'],'Model layer');
    if(!/^sha256:[a-f0-9]{64}$/.test(layer.digest))throw new Error('Invalid model layer digest');positive(layer.size,'Layer size');
    const path='models/blobs/'+layer.digest.replace(':','-'),previous=expected.get(path);
    if(previous&&previous.size!==layer.size)throw new Error('Contradictory model layer sizes');
    expected.set(path,{sha256:layer.digest.slice(7),size:layer.size});
  }
  const bundle=object(delivery.bundle,['schemaVersion','kind','releaseBaseUrl','files'],'Model bundle');
  if(bundle.schemaVersion!==1||bundle.kind!=='neurocenter-model-bundle'||!Array.isArray(bundle.files)||bundle.files.length!==expected.size)throw new Error('Model bundle does not cover exact lock');
  releaseUrl(bundle.releaseBaseUrl+'/placeholder.bin');
  const seen=new Set(),parts=new Set();
  for(const file of bundle.files) {
    object(file,['path','size','sha256','parts','inlineBase64'],'Model bundle file');safePath(file.path);sha(file.sha256);positive(file.size,'Model file size');
    const expectedFile=expected.get(file.path);
    if(seen.has(file.path)||!expectedFile||expectedFile.sha256!==file.sha256||expectedFile.size!==undefined&&expectedFile.size!==file.size)throw new Error('Unexpected, duplicate or changed model file');seen.add(file.path);
    if(expectedFile.manifest) {
      if(file.parts!==undefined||typeof file.inlineBase64!=='string'||file.size>128*1024||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.inlineBase64))throw new Error('Invalid inline model manifest');
      const bytes=Buffer.from(file.inlineBase64,'base64');
      if(bytes.length!==file.size||assetDigest(bytes)!==file.sha256||!isDeepStrictEqual(JSON.parse(bytes.toString('utf8')),lock.manifest))throw new Error('Model manifest SHA or lock content mismatch');
    }else {
      if(file.inlineBase64!==undefined||!Array.isArray(file.parts)||!file.parts.length||file.parts.length>64)throw new Error('Pinned model file parts required');
      let total=0;for(const [index,part]of file.parts.entries()) {
        object(part,['name','size','sha256'],'Model part');sha(part.sha256);positive(part.size,'Model part size');
        if(part.size>1024**3||part.name!==`model-${file.sha256}-${String(index+1).padStart(3,'0')}.bin`||parts.has(part.name))throw new Error('Invalid or duplicate model part');
        parts.add(part.name);total+=part.size;
      }
      if(total!==file.size)throw new Error('Model part size total mismatch');
    }
  }
}

/** Bridge metadata keeps its existing native target names, Node and probe-engine pinning. */
export function validateBridgeDelivery(asset) {
  object(asset.card,['name','description','tags'],'Bridge card');text(asset.card.name,'Bridge name',128);text(asset.card.description,'Bridge description',2000);
  if(asset.card.tags!==undefined)stringList(asset.card.tags,'Tags');
  object(asset.delivery,['type','release'],'Bridge delivery');if(asset.delivery.type!=='bridge-release')throw new Error('Bridge release required');
  const release=object(asset.delivery.release,['schemaVersion','version','buildId','release','artifacts'],'Bridge release');
  if(release.schemaVersion!==1||!/^\d+\.\d+\.\d+$/.test(release.version)||release.release!==`bridge-v${release.version}`||release.version!==asset.version||!Array.isArray(release.artifacts)||!release.artifacts.length||release.artifacts.length>8)throw new Error('Invalid native bridge release');sha(release.buildId);
  const targets=['darwin-arm64','darwin-x64','linux-arm64','linux-x64','linux-arm64-musl','linux-x64-musl','windows-arm64','windows-x64'],seen=new Set();
  for(const artifact of release.artifacts) {
    object(artifact,['file','url','metadata'],'Bridge artifact');const url=releaseUrl(artifact.url);
    const metadata=object(artifact.metadata,['version','target','nodeVersion','buildId','ragSupported','probeEngine','windowsJobHelper','sha256','bytes'],'Bridge metadata');
    if(!targets.includes(metadata.target)||seen.has(metadata.target)||metadata.version!==release.version||metadata.buildId!==release.buildId
      ||typeof metadata.nodeVersion!=='string'||!/^24\.\d+\.\d+$/.test(metadata.nodeVersion)||typeof metadata.ragSupported!=='boolean')throw new Error('Bridge runtime metadata mismatch');seen.add(metadata.target);
    sha(metadata.sha256);positive(metadata.bytes,'Bridge bytes');
    object(metadata.probeEngine,['version','sha256','file'],'Probe engine');pin(metadata.probeEngine.version,'Probe version');sha(metadata.probeEngine.sha256);
    if(metadata.probeEngine.file!==`bin/opencode-probe${metadata.target.startsWith('windows-')?'.exe':''}`)throw new Error('Bridge probe path mismatch');
    if(metadata.windowsJobHelper!==undefined) {object(metadata.windowsJobHelper,['file','sha256'],'Windows helper');sha(metadata.windowsJobHelper.sha256);if(metadata.windowsJobHelper.file!=='bin/neurocenter-job.exe')throw new Error('Invalid Windows helper');}
    const file=`neurocenter-asset-sync-${metadata.target}-${release.version}.tgz`;
    if(artifact.file!==file||!url.pathname.endsWith(`/releases/download/${release.release}/${file}`))throw new Error('Bridge archive name or release mismatch');
  }
}
