'use strict';
const {createHash}=require('node:crypto');
const {portablePath}=require('./runtime-artifacts.cjs');
const {validateRuntimeSource,runtimeSourceTargets}=require('./tool-runtime-source.cjs');
const {isSourceEntrypoint,SOURCE_EXTENSIONS}=require('./source-entrypoint.cjs');
const {validateReleaseInput,resolveGithubRelease}=require('./github-release-source.cjs');
const {packageEntrypoints}=require('./source-candidates.cjs');
const {RAG_PLUGIN_SOURCE,isPreparedRagRepository}=require('./opencode-rag-source.cjs');
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
const commitPattern=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const manifestName='neurocenter.tool.json';

function relativePath(value,label){
 if(typeof value!=='string'||!portablePath(value)||value.split('/').some(part=>part.toLowerCase()==='.git'))throw new Error(label+': нужен относительный переносимый путь без .. и .git.');
 return value;
}
function reference(value){
 if(typeof value!=='string'||value.length>200||!/^[a-z0-9][a-z0-9._+/-]*$/i.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..')||value.includes('..'))throw new Error('Укажите ветку, тег или полный commit без управляющих символов и выражений Git.');
 return value;
}
function decode(value){try{return decodeURIComponent(value);}catch{throw new Error('Некорректное кодирование ссылки GitHub.');}}

/** Обычная tree-ссылка задаёт первый сегмент ветки; ветку со слешем можно уточнить полем ref. */
function parseRepositoryUrl(value,options={}){
 if(typeof value!=='string'||value.length>2048||/[\x00-\x20\x7f\\]/.test(value))throw new Error('Укажите публичный репозиторий https://github.com/владелец/репозиторий.');
 let parsed;try{parsed=new URL(value);}catch{throw new Error('Некорректная ссылка GitHub.');}
 if(parsed.protocol!=='https:'||parsed.hostname!=='github.com'||parsed.port||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('Поддерживаются публичные HTTPS-репозитории github.com без токенов, параметров и фрагментов.');
 const rawPath=/^https:\/\/[^/]+(\/[^?#]*)/i.exec(value)?.[1]||'';
 if(decode(rawPath).split('/').some(part=>part==='.'||part==='..'))throw new Error('Ссылка GitHub не должна содержать . или .. в пути.');
 const parts=parsed.pathname.replace(/\/$/,'').split('/').slice(1);
 const owner=decode(parts[0]||''),repository=decode(parts[1]||'').replace(/\.git$/i,'');
 if(!/^[a-z0-9][a-z0-9-]{0,38}$/i.test(owner)||!/^[a-z0-9._-]{1,100}$/i.test(repository)||repository==='.'||repository==='..')throw new Error('Некорректные владелец или имя репозитория GitHub.');
 let ref=options.ref===undefined||options.ref===''?undefined:reference(options.ref),subdirectory=options.subdirectory===undefined||options.subdirectory===''?undefined:relativePath(options.subdirectory,'Папка проекта');
 let release;
 if(parts[2]==='releases'){
  if(parts[3]==='latest'&&parts.length===4)release={tag:'latest'};
  else if(parts[3]==='tag'&&parts.length>=5)release={tag:parts.slice(4).map(decode).join('/')};
  else if(parts[3]==='download'&&parts.length>=6)release={tag:parts.slice(4,-1).map(decode).join('/'),asset:decode(parts.at(-1))};
  else throw new Error('Используйте ссылку /releases/tag/тег или /releases/download/тег/файл.');
  release=validateReleaseInput(release);
  if(subdirectory)throw new Error('Подпапка относится к исходникам, а не к файлу релиза.');
 }else if(parts.length>2){
  if(parts[2]!=='tree'||parts.length<4||parts.slice(3).some(part=>!part))throw new Error('Используйте ссылку на репозиторий или его /tree/ветка/папка.');
  const tail=parts.slice(3).map(decode).join('/');
  const treeRef=ref??reference(decode(parts[3]));
  if(tail!==treeRef&&!tail.startsWith(treeRef+'/'))throw new Error('Ветка ref не совпадает со ссылкой tree. Укажите канонический URL репозитория и ref отдельно.');
  const treeDirectory=tail===treeRef?undefined:relativePath(tail.slice(treeRef.length+1),'Папка в ссылке tree');
  if(subdirectory&&treeDirectory&&subdirectory!==treeDirectory)throw new Error('Папка subdirectory не совпадает с папкой в ссылке tree.');
  ref=treeRef;subdirectory=subdirectory??treeDirectory;
 }
 return {url:`https://github.com/${owner.toLowerCase()}/${repository.toLowerCase()}`,owner:owner.toLowerCase(),repository:repository.toLowerCase(),...(ref?{ref}:{}),...(subdirectory?{subdirectory}:{}),...(release?{release}:{})};
}

/** Builder принимает только полный commit; HTTP-форма может передать ветку до разрешения через GitHub. */
function validateRepositorySource(value,{pinned=true}={}){
 if(!exact(value,pinned?['type','url','commit','subdirectory','entrypoint','runtimeSource','manifestSha256','release','snapshotSha256']:['type','url','ref','subdirectory','entrypoint','release'])||value.type!=='repository')throw new Error('Источник repository содержит неподдерживаемые поля.');
 const parsed=parseRepositoryUrl(value.url,pinned?{subdirectory:value.subdirectory}:{ref:value.ref,subdirectory:value.subdirectory});
 const release=value.release?validateReleaseInput(value.release):parsed.release;
 if(value.release&&parsed.release&&(release.tag!==parsed.release.tag||parsed.release.asset&&release.asset!==parsed.release.asset))throw new Error('Поля релиза не совпадают со ссылкой.');
 const entrypoint=!pinned&&(value.entrypoint===undefined||value.entrypoint==='')?undefined:relativePath(value.entrypoint,'Файл запуска');
 if(entrypoint&&/\.d\.[cm]?ts$/i.test(entrypoint))throw new Error('Нужен исполняемый JS/TS-файл, без деклараций типов.');
 if(pinned&&!value.snapshotSha256&&!release&&entrypoint&&entrypoint!==manifestName&&!isSourceEntrypoint(entrypoint))throw new Error('Репозиторий должен содержать исполняемый JS/TS-файл запуска или neurocenter.tool.json, без деклараций типов.');
 if(pinned){
  if(typeof value.commit!=='string'||!commitPattern.test(value.commit))throw new Error('Репозиторий должен быть закреплён полным SHA commit (40 или 64 hex).');
  if(release){
   if(!release.id||!release.assetId||!release.sha256||!release.asset||!entrypoint||value.manifestSha256!==undefined||!value.runtimeSource)throw new Error('Релиз требует закреплённые id, SHA-256 и сгенерированную поставку.');
   const runtimeSource=validateRuntimeSource(value.runtimeSource);
   for(const bundle of Object.values(runtimeSource.assets))for(const asset of [bundle.app,bundle.runtime].filter(Boolean)){
    const expected=`${parsed.url}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(release.asset)}`;
    if(asset.url!==expected||asset.sha256!==release.sha256)throw new Error('Поставка не совпадает с закреплённым файлом релиза.');
   }
   return {type:'repository',url:parsed.url,commit:value.commit.toLowerCase(),entrypoint,release,runtimeSource};
  }
  if(value.snapshotSha256!==undefined){
   if(!/^[a-f0-9]{64}$/.test(value.snapshotSha256)||value.manifestSha256!==undefined||!value.runtimeSource)throw new Error('Сгенерированная поставка требует SHA-256 снимка и runtime.');
   const runtimeSource=validateRuntimeSource(value.runtimeSource);
   for(const bundle of Object.values(runtimeSource.assets))for(const asset of [bundle.app,bundle.runtime].filter(Boolean))if(asset.directory!=='.')throw new Error('Сгенерированная поставка должна использовать только закреплённую папку репозитория.');
   return {type:'repository',url:parsed.url,commit:value.commit.toLowerCase(),...(parsed.subdirectory?{subdirectory:parsed.subdirectory}:{}),entrypoint,runtimeSource,snapshotSha256:value.snapshotSha256};
  }
  const manifest=entrypoint===manifestName;
  if(manifest?typeof value.manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(value.manifestSha256)||!value.runtimeSource:value.runtimeSource!==undefined||value.manifestSha256!==undefined)throw new Error('Источник manifest требует runtimeSource и SHA-256; у JS/TS-источника эти поля запрещены.');
  return {type:'repository',url:parsed.url,commit:value.commit.toLowerCase(),...(parsed.subdirectory?{subdirectory:parsed.subdirectory}:{}),entrypoint,
   ...(manifest?{runtimeSource:validateRuntimeSource(value.runtimeSource),manifestSha256:value.manifestSha256}:{})};
 }
 return {type:'repository',url:parsed.url,...(parsed.ref?{ref:parsed.ref}:{}),...(parsed.subdirectory?{subdirectory:parsed.subdirectory}:{}),...(entrypoint?{entrypoint}:{}),...(release?{release}:{})};
}

async function githubJson(fetcher,pathname,{optional=false}={}){
 let response;
 try{response=await fetcher('https://api.github.com'+pathname,{redirect:'error',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Neurocenter-Catalog'},signal:AbortSignal.timeout(20000)});}
 catch{throw new Error('GitHub недоступен. Повторите проверку репозитория.');}
 if(response.status===404&&optional)return undefined;
 if(!response.ok)throw new Error(response.status===403||response.status===429?'GitHub временно ограничил запросы. Повторите позже.':'Публичный репозиторий, ветка или файл не найдены. Для ветки со слешем уточните ref.');
 const reader=response.body?.getReader();if(!reader)throw new Error('GitHub вернул пустой ответ.');
 const chunks=[];let bytes=0;
 try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>2*1024*1024){await reader.cancel().catch(()=>undefined);throw new Error('Описание GitHub превышает допустимый размер.');}chunks.push(part.value);}}
 catch(error){if(error?.message==='Описание GitHub превышает допустимый размер.')throw error;throw new Error('Загрузка описания GitHub оборвалась. Повторите проверку.');}
 finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('GitHub вернул некорректный JSON.');}
}
function githubFileBytes(value,label){
 if(!object(value)||value.type!=='file'||value.encoding!=='base64'||!Number.isSafeInteger(value.size)||value.size<1||value.size>65536||typeof value.content!=='string'||value.content.length>90000)throw new Error(label+' репозитория должен быть обычным файлом до 64 КиБ.');
 const normalized=value.content.replace(/\n/g,'');
 const bytes=Buffer.from(normalized,'base64');
 if(bytes.toString('base64')!==normalized||bytes.length!==value.size||!Buffer.from(bytes.toString('utf8')).equals(bytes))throw new Error('GitHub вернул повреждённый '+label+'.');
 return bytes;
}
function decodePackage(value){
 const bytes=githubFileBytes(value,'package.json');
 try{const metadata=JSON.parse(bytes.toString('utf8'));if(!object(metadata))throw new Error();return metadata;}catch{throw new Error('package.json репозитория содержит некорректный JSON.');}
}

/** Одну и ту же строгую декларацию проверяют GitHub resolver и сборщик закреплённого архива. */
function validateRepositoryManifest(value){
 if(typeof value!=='string'&&!Buffer.isBuffer(value))throw new Error(manifestName+' должен содержать UTF-8 JSON.');
 const bytes=Buffer.isBuffer(value)?value:Buffer.from(value,'utf8');
 if(!bytes.length||bytes.length>65536||!Buffer.from(bytes.toString('utf8')).equals(bytes))throw new Error(manifestName+' должен содержать UTF-8 JSON до 64 КиБ.');
 let manifest;try{manifest=JSON.parse(bytes.toString('utf8'));}catch{throw new Error(manifestName+' содержит некорректный JSON.');}
 if(!exact(manifest,['schemaVersion','name','description','source'])||manifest.schemaVersion!==1)throw new Error(manifestName+' требует schemaVersion: 1, source и только известные поля.');
 if(manifest.name!==undefined&&(typeof manifest.name!=='string'||!manifest.name.trim()||manifest.name.length>128||/[\x00-\x1f\x7f]/.test(manifest.name)))throw new Error('Название в '+manifestName+' должно содержать до 128 символов.');
 if(manifest.description!==undefined&&(typeof manifest.description!=='string'||manifest.description.length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(manifest.description)))throw new Error('Описание в '+manifestName+' должно содержать до 2000 символов.');
 return {schemaVersion:1,...(manifest.name!==undefined?{name:manifest.name.trim()}:{}),...(manifest.description!==undefined?{description:manifest.description.trim()}:{}),source:validateRuntimeSource(manifest.source)};
}

/** Все чтения после commits/{ref} используют только полученный SHA; URL загрузки из API не исполняется. */
async function resolveRepositorySource(input,{fetch:fetcher=globalThis.fetch,metadata:includeMetadata=true,inspectAsset,inspectRepository}={}){
 const source=validateRepositorySource({type:'repository',...input},{pinned:false});
 const parsed=parseRepositoryUrl(source.url),base=`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}`;
 const repository=await githubJson(fetcher,base);
 if(!object(repository)||repository.private!==false||typeof repository.default_branch!=='string')throw new Error('Поддерживаются только публичные репозитории GitHub.');
 if(source.release)return resolveGithubRelease({source,parsed,repository,base,githubJson,fetcher,inspectAsset});
 const ref=source.ref??reference(repository.default_branch);
 const resolved=await githubJson(fetcher,base+'/commits/'+encodeURIComponent(ref));
 if(!object(resolved)||typeof resolved.sha!=='string'||!commitPattern.test(resolved.sha))throw new Error('GitHub не подтвердил полный SHA commit.');
 const commit=resolved.sha.toLowerCase(),prefix=source.subdirectory?source.subdirectory+'/':'';
 const contentsPath=relative=>{const file=(prefix+relative).replace(/\/$/,'');return base+'/contents'+(file?'/'+file.split('/').map(encodeURIComponent).join('/'):'')+'?ref='+commit;};
 const result=(entrypoint,candidates,metadata={})=>({url:source.url,commit,ref,...(source.subdirectory?{subdirectory:source.subdirectory}:{}),entrypoint,candidates,
  name:typeof metadata.name==='string'?metadata.name.slice(0,128):typeof repository.name==='string'?repository.name:parsed.repository,
  description:typeof metadata.description==='string'?metadata.description.slice(0,2000):typeof repository.description==='string'?repository.description.slice(0,2000):'',
  ...(object(metadata.dependencies)&&metadata.dependencies['@opencode-ai/plugin']?{recommendedKind:'plugin'}:
   object(metadata.dependencies)&&metadata.dependencies['@modelcontextprotocol/sdk']?{recommendedKind:'mcp'}:{})});
 const manifestResult=entry=>{
  const bytes=githubFileBytes(entry,manifestName),manifest=validateRepositoryManifest(bytes);
  return {...result(manifestName,[manifestName],manifest),recommendedKind:'mcp',adapter:manifest.source.adapter,
   supportedTargets:runtimeSourceTargets(manifest.source),runtimeSource:manifest.source,manifestSha256:createHash('sha256').update(bytes).digest('hex')};
 };
 if(isPreparedRagRepository({...source,commit})){
  const prepared=RAG_PLUGIN_SOURCE;
  const entry=await githubJson(fetcher,contentsPath(prepared.entrypoint),{optional:true});
  if(!object(entry)||entry.type!=='file'||!Number.isSafeInteger(entry.size)||entry.size<1||entry.size>1048576)throw new Error('Файл плагина OpenCodeRAG отсутствует в закреплённом commit.');
  return {...result(prepared.entrypoint,[prepared.entrypoint],{name:'OpenCodeRAG (плагин)',description:'Плагин OpenCodeRAG от MrDoe: инструменты поиска, hooks и автоматическое индексирование. Совместимая сборка для OpenCode 1.x без интерфейса TUI OpenCode V2.'}),
   recommendedKind:'plugin',preparedAdapter:prepared.adapter,preparedVersion:prepared.version,supportedTargets:[...prepared.supportedTargets]};
 }
 if(source.entrypoint===manifestName)return manifestResult(await githubJson(fetcher,contentsPath(manifestName)));
 if(source.entrypoint&&!isSourceEntrypoint(source.entrypoint)&&source.entrypoint!==manifestName){
  if(typeof inspectRepository!=='function')throw new Error('Проверка готовой поставки репозитория недоступна.');
  return {...result('',[]),...await inspectRepository({type:'repository',url:source.url,commit,...(source.subdirectory?{subdirectory:source.subdirectory}:{})},source.entrypoint)};
 }
 if(source.entrypoint&&!includeMetadata){
  const entry=await githubJson(fetcher,contentsPath(source.entrypoint),{optional:true});
  if(!object(entry)||entry.type!=='file'||!Number.isSafeInteger(entry.size)||entry.size<1||entry.size>1048576)throw new Error('Файл запуска не найден в закреплённом commit или является ссылкой.');
  return result(source.entrypoint,[source.entrypoint]);
 }
 const directory=await githubJson(fetcher,contentsPath(''));
 if(!Array.isArray(directory)||directory.length>1000)throw new Error('Папка репозитория недоступна или слишком велика для просмотра.');
 const listings=new Map(directory.filter(object).map(entry=>[entry.name,entry]));
 const knownEntries=new Map(directory.filter(object).map(entry=>[entry.name,entry]));
 if(!source.entrypoint&&listings.has(manifestName))return manifestResult(await githubJson(fetcher,contentsPath(manifestName)));
 const packageEntry=listings.get('package.json');
 const metadata=packageEntry?decodePackage(await githubJson(fetcher,contentsPath('package.json'))):{};
 const candidates=[];
 const add=value=>{if(typeof value!=='string')return;try{const entry=relativePath(value.replace(/^\.\//,''),'Файл запуска');if(isSourceEntrypoint(entry)&&!candidates.includes(entry))candidates.push(entry);}catch{}};
 const bins=(typeof metadata.bin==='string'?[metadata.bin]:object(metadata.bin)?Object.values(metadata.bin):[]).filter(value=>typeof value==='string'&&isSourceEntrypoint(value));
 for(const value of bins.length?bins:[metadata.main,metadata.module,metadata.source])add(value);
 const exports=object(metadata.exports)&&metadata.exports['.']!==undefined?metadata.exports['.']:metadata.exports;
 if(!bins.length&&typeof exports==='string')add(exports);else if(!bins.length&&object(exports))for(const key of ['import','default','node','require']){const value=exports[key];if(typeof value==='string')add(value);else if(object(value))for(const nested of ['import','default','require'])add(value[nested]);}
 for(const baseName of ['index','main','plugin','server'])for(const suffix of SOURCE_EXTENSIONS){if(!bins.length&&listings.get(baseName+'.'+suffix)?.type==='file')add(baseName+'.'+suffix);}
 const src=listings.get('src');
 if(src?.type==='dir'){
  const nested=await githubJson(fetcher,contentsPath('src'),{optional:true});
  if(Array.isArray(nested)&&nested.length<=1000){
   for(const entry of nested.filter(object))knownEntries.set('src/'+entry.name,entry);
   for(const baseName of ['index','main','plugin','server'])for(const suffix of SOURCE_EXTENSIONS){if(!bins.length&&nested.some(entry=>entry?.name===baseName+'.'+suffix&&entry.type==='file'))add('src/'+baseName+'.'+suffix);}
  }
 }
 const wanted=source.entrypoint?[source.entrypoint,...candidates.filter(value=>value!==source.entrypoint)]:candidates;
 const verified=[];
 for(const candidate of wanted.slice(0,12)){
  const file=knownEntries.has(candidate)?knownEntries.get(candidate):await githubJson(fetcher,contentsPath(candidate),{optional:true});
  if(object(file)&&file.type==='file'&&Number.isSafeInteger(file.size)&&file.size>0&&file.size<=1048576)verified.push(candidate);
  else if(source.entrypoint===candidate)throw new Error('Файл запуска не найден в закреплённом commit или является ссылкой.');
 }
 const entrypoint=source.entrypoint??(verified.length===1?verified[0]:'');
 if(!verified.length){
  if(typeof inspectRepository==='function')return {...result('',[],metadata),...await inspectRepository({type:'repository',url:source.url,commit,...(source.subdirectory?{subdirectory:source.subdirectory}:{})})};
  throw new Error('В репозитории не найден JS/TS-файл запуска. Уточните папку проекта и entrypoint.');
 }
 const detected=packageEntrypoints(metadata);
 return {...result(entrypoint,verified,metadata),requiresEntrypointChoice:verified.length>1&&!source.entrypoint,runnableKinds:detected.runnableKinds,warnings:detected.runnableKinds.length?[]:['Не найдены команда запуска MCP или признаки плагина OpenCode. Обычный библиотечный export не является MCP.']};
}

module.exports={parseRepositoryUrl,validateRepositorySource,validateRepositoryManifest,normalizeRepositorySource:validateRepositorySource,resolveRepositorySource};
