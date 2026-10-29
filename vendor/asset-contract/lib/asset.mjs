import {KINDS,identifier,object,text,pin,sha,positive,safePath,https,repository,releaseUrl,stringList,canonicalJson} from './validation.mjs';
import {validateModelDelivery,validateBridgeDelivery} from './native-delivery.mjs';
import {assertPortableCardDependencies,nativePins} from './dependencies.mjs';
import {validateAgentDelivery} from './agent.mjs';

const toolFields=['name','kind','description','version','compatibility','tags','origin','revision','config','files','dependencies'];
const targets=['darwin-arm64','darwin-x64','linux-arm64-glibc','linux-x64-glibc','linux-arm64-musl','linux-x64-musl','win32-arm64','win32-x64'];

function source(value) {
  if(value?.type==='git') {
    object(value,['type','repository','commit','path'],'Git source');repository(value.repository);
    if(typeof value.commit!=='string'||!/^[a-f0-9]{40}$/.test(value.commit))throw new Error('Git source requires full commit SHA');
    if(value.path!==undefined)safePath(value.path);
  }else if(value?.type==='npm') {
    object(value,['type','name','version','integrity'],'npm source');
    if(typeof value.name!=='string'||!/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(value.name))throw new Error('Invalid npm name');pin(value.version,'npm version');
    if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(value.version))throw new Error('Exact npm semver required');
    if(value.integrity!==undefined&&(typeof value.integrity!=='string'||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity)))throw new Error('Invalid npm integrity');
  }else if(value?.type==='archive') {
    object(value,['type','sha256','bytes'],'Archive source');sha(value.sha256,'Archive SHA-256');positive(value.bytes,'Archive bytes');
  }else if(value?.type==='release') {
    object(value,['type','repository','tag'],'Release source');repository(value.repository);pin(value.tag,'Release tag');
  }else throw new Error('Unsupported asset source');
}

function tool(asset) {
  const card=object(asset.card,toolFields,'Tool publication');
  if(card.kind!==asset.kind||card.version!==undefined&&card.version!==1)throw new Error('Tool kind or initial version mismatch');
  text(card.name,'Name',128);text(card.description,'Description',2000);pin(card.revision,'Publication revision');
  assertPortableCardDependencies(card.dependencies);
  if(card.tags!==undefined)stringList(card.tags,'Tags');
  if(!Array.isArray(card.files)||card.files.length>100)throw new Error('Tool files must be a native publication list');
  const config=object(card.config,['transport','command','args','env','url','headers','oauth','entrypoint','extra'],'Tool config');
  if(config.extra!==undefined&&Object.hasOwn(config.extra,'runtimeArtifacts'))throw new Error('Declare runtime artifacts only in delivery, never twice in card');
  object(asset.delivery,['type','artifacts'],'Tool delivery');
  if(asset.delivery.type!=='runtime-artifacts'||!Array.isArray(asset.delivery.artifacts)||asset.delivery.artifacts.length>8)throw new Error('Invalid runtime delivery');
  const seen=new Set(),hashes=new Map();
  for(const artifact of asset.delivery.artifacts) {
    object(artifact,['url','descriptor'],'Runtime artifact');if(artifact.url!==undefined)releaseUrl(artifact.url);
    const item=object(artifact.descriptor,['target','sha256','compressedBytes','unpackedBytes','filesCount','entrypoint','executable'],'Runtime descriptor');
    if(!targets.includes(item.target)||seen.has(item.target))throw new Error('Invalid or duplicate runtime target');seen.add(item.target);
    sha(item.sha256);safePath(item.entrypoint);['compressedBytes','unpackedBytes','filesCount'].forEach(key=>positive(item[key],key));
    const previous=hashes.get(item.sha256);
    if(previous&&['compressedBytes','unpackedBytes','filesCount'].some(key=>previous[key]!==item[key]))throw new Error('One runtime SHA has contradictory inventory sizes');
    hashes.set(item.sha256,item);
    if(item.executable!==undefined&&typeof item.executable!=='boolean')throw new Error('Invalid executable flag');
    if(asset.kind==='plugin'&&(item.executable||!/\.(m?js|cjs)$/.test(item.entrypoint)))throw new Error('Plugin requires a JavaScript module');
  }
}
function skill(asset) {
  const card=object(asset.card,['path','slug','name','body','meta','resources'],'Skill publication');
  if(card.path!=='common'||typeof card.slug!=='string'||!/^([a-z0-9]+-)*[a-z0-9]+$/.test(card.slug)||card.slug.length>64)throw new Error('Asset skill requires common path and portable slug');
  text(card.name,'Skill name',128);
  if(typeof card.body!=='string'||!card.body.trim()||card.body.includes('\0')||Buffer.byteLength(card.body)>1024**2)throw new Error('Invalid skill body');
  const meta=object(card.meta,['description','tags','mcp','plugins','specialization','dependencies'],'Skill metadata');text(meta.description,'Skill description',1024);
  assertPortableCardDependencies(meta.dependencies);
  for(const key of ['tags','mcp','plugins'])if(meta[key]!==undefined)stringList(meta[key],key);
  if(meta.mcp?.length||meta.plugins?.length)throw new Error('Skill dependencies require exact package pins, not legacy names');
  if(card.resources!==undefined) {
    if(!Array.isArray(card.resources)||card.resources.length>99)throw new Error('Invalid skill resources');
    const seen=new Set();
    for(const resource of card.resources) {
      object(resource,['path','content','encoding'],'Skill resource');safePath(resource.path);
      if(!/^(scripts|references|assets)\//.test(resource.path)||seen.has(resource.path.toLowerCase())||typeof resource.content!=='string'
        ||resource.encoding!==undefined&&resource.encoding!=='base64')throw new Error('Invalid or duplicate skill resource');
      seen.add(resource.path.toLowerCase());
    }
  }
  object(asset.delivery,['type'],'Skill delivery');if(asset.delivery.type!=='inline')throw new Error('Skill delivery must be inline');
}

/** Envelope validation is shared by producers and importers; app domain validators remain mandatory at persistence boundaries. */
export function validateAsset(value) {
  const asset=object(value,['schemaVersion','id','kind','version','source','license','compatibility','card','delivery','dependencies','recipe'],'Asset');
  if(asset.schemaVersion!==1||!identifier(asset.id)||!KINDS.includes(asset.kind))throw new Error('Unsupported asset schema, ID or kind');
  pin(asset.version,'Asset version');source(asset.source);
  object(asset.license,['spdx','url'],'License');text(asset.license.spdx,'SPDX identifier',128);if(asset.license.url!==undefined)https(asset.license.url,'License URL');
  object(asset.compatibility,['packageFormat','bridgeProtocol'],'Compatibility');
  if(asset.compatibility.packageFormat!==undefined&&asset.compatibility.packageFormat!==5||asset.compatibility.bridgeProtocol!==undefined&&asset.compatibility.bridgeProtocol!==2)throw new Error('Unsupported package format or bridge protocol');
  if(['mcp','plugin','skill'].includes(asset.kind)&&asset.compatibility.packageFormat!==5)throw new Error('Package format 5 required');
  if(asset.kind==='bridge'&&asset.compatibility.bridgeProtocol!==2)throw new Error('Bridge protocol 2 required');
  if(asset.dependencies!==undefined) {
    if(!Array.isArray(asset.dependencies)||asset.dependencies.length>20)throw new Error('Invalid dependencies');
    const ids=new Set();for(const dependency of asset.dependencies) {
      object(dependency,['id','version','sha256'],'Dependency');
      if(!identifier(dependency.id)||ids.has(dependency.id)||dependency.id===asset.id)throw new Error('Duplicate or self dependency');
      ids.add(dependency.id);pin(dependency.version,'Dependency version');sha(dependency.sha256);
    }
  }
  if(asset.recipe!==undefined) {object(asset.recipe,['path','sha256'],'Recipe');safePath(asset.recipe.path);sha(asset.recipe.sha256);}
  if(['mcp','plugin'].includes(asset.kind))tool(asset);
  else if(asset.kind==='skill')skill(asset);
  else if(asset.kind==='model')validateModelDelivery(asset);
  else if(asset.kind==='agent')validateAgentDelivery(asset);
  else validateBridgeDelivery(asset);
  if(Buffer.byteLength(canonicalJson(asset))>16*1024**2)throw new Error('Asset descriptor exceeds 16 MiB');
  return asset;
}
export function serializeAsset(value) {return canonicalJson(validateAsset(value));}
export function toToolPublication(asset,context) {
  validateAsset(asset);if(!['mcp','plugin'].includes(asset.kind))throw new Error('Expected tool asset');
  const card=structuredClone(asset.card),artifacts=asset.delivery.artifacts.map(item=>structuredClone(item.descriptor));
  const dependencies=nativePins(asset,context);if(dependencies.length)card.dependencies=dependencies;
  if(artifacts.length)card.config={...card.config,extra:{...card.config.extra,runtimeArtifacts:artifacts}};
  return card;
}
export function toSkillCreate(asset,context) {validateAsset(asset);if(asset.kind!=='skill')throw new Error('Expected skill asset');const card=structuredClone(asset.card),dependencies=nativePins(asset,context);if(dependencies.length)card.meta.dependencies=dependencies;return card;}
/** Source edges remain supply-only: the consumer resolves and persists their immutable retention before this projection. */
export function toModelRecord(asset) {validateAsset(asset);if(asset.kind!=='model')throw new Error('Expected model asset');return structuredClone(asset.card);}
/** Bridge source edges are supply references, never MCP runtime dependency pins. */
export function toBridgeRelease(asset) {validateAsset(asset);if(asset.kind!=='bridge')throw new Error('Expected bridge asset');return structuredClone(asset.delivery.release);}
/** Native agents remain standalone inline definitions, never disguised plugin packages. */
export function toAgentRecord(asset) {validateAsset(asset);if(asset.kind!=='agent')throw new Error('Expected agent asset');return structuredClone(asset.card);}
