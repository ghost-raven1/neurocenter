'use strict';
const {validateRuntimeSource}=require('./tool-runtime-source.cjs');
const {portablePath}=require('./runtime-artifacts.cjs');
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
/** Client pins release identity and asset bytes; generated runtime recipes remain server-owned. */
function validateReleaseInput(value){
 if(!object(value)||Object.keys(value).some(key=>!['tag','asset','id','assetId','sha256'].includes(key))||typeof value.tag!=='string'||!value.tag||value.tag.length>200||/[\x00-\x20\x7f\\]/.test(value.tag))throw new Error('Укажите тег релиза GitHub.');
 if(value.asset!==undefined&&(typeof value.asset!=='string'||!portablePath(value.asset)||value.asset.includes('/')))throw new Error('Укажите имя файла релиза без папок.');
 for(const key of ['id','assetId'])if(value[key]!==undefined&&!positive(value[key]))throw new Error('Некорректный идентификатор релиза GitHub.');
 if(value.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(value.sha256))throw new Error('Некорректный SHA-256 файла релиза.');
 if((value.assetId!==undefined||value.sha256!==undefined)&&!value.asset)throw new Error('Закреплённому файлу нужно имя asset.');
 return {tag:value.tag,...(value.asset?{asset:value.asset}:{}),...(value.id?{id:value.id}:{}),...(value.assetId?{assetId:value.assetId}:{}),...(value.sha256?{sha256:value.sha256}:{})};
}
function releaseAsset(value,{owner,repository,tag}){
 if(!object(value)||!positive(value.id)||typeof value.name!=='string'||!portablePath(value.name)||value.name.includes('/')||!positive(value.size)||value.size>256*1024**2||value.state!=='uploaded')return;
 const format=/\.(?:tar\.gz|tgz)$/i.test(value.name)?'tar.gz':/\.zip$/i.test(value.name)?'zip':/\.(?:asc|sig|sha256|sha512|txt|json|ya?ml|md|pdf|png|jpe?g|svg|deb|rpm|dmg|pkg|msi|pdb)$/i.test(value.name)?undefined:'file';
 if(!format||/\.(?:asc|sig|sha256|txt)$/i.test(value.name))return;
 const expected=`https://github.com/${owner}/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(value.name)}`;
 let url;try{url=new URL(value.browser_download_url);}catch{return;}
 if(url.protocol!=='https:'||url.hostname!=='github.com'||url.port||url.username||url.password||url.search||url.hash)return;
 const parts=url.pathname.split('/').slice(1);
 let tail;try{tail=parts.slice(4).map(decodeURIComponent).join('/');}catch{return;}
 if(parts[0]?.toLowerCase()!==owner||parts[1]?.toLowerCase()!==repository||parts[2]!=='releases'||parts[3]!=='download'||tail!==tag+'/'+value.name)return;
 const sha256=typeof value.digest==='string'&&/^sha256:[a-f0-9]{64}$/.test(value.digest)?value.digest.slice(7):undefined;
 return {id:value.id,name:value.name,bytes:value.size,url:expected,format,...(sha256?{sha256}:{})};
}
/** Only API-confirmed release assets are offered; source-code ZIPs are not executable releases. */
async function resolveGithubRelease({source,parsed,repository,base,githubJson,fetcher,inspectAsset}){
 const requested=validateReleaseInput(source.release);
 const release=await githubJson(fetcher,base+(requested.tag==='latest'?'/releases/latest':'/releases/tags/'+encodeURIComponent(requested.tag)));
 if(!object(release)||!positive(release.id)||release.draft!==false||typeof release.tag_name!=='string'||!release.tag_name||!Array.isArray(release.assets)||release.assets.length>200)throw new Error('GitHub не подтвердил публичный релиз.');
 if(requested.id&&requested.id!==release.id)throw new Error('Релиз заменён после просмотра. Проверьте источник заново.');
 const tag=release.tag_name;
 const resolved=await githubJson(fetcher,base+'/commits/'+encodeURIComponent(tag));
 if(!object(resolved)||typeof resolved.sha!=='string'||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(resolved.sha))throw new Error('GitHub не подтвердил commit тега релиза.');
 const commit=resolved.sha.toLowerCase();
 if(source.ref&&source.ref!==commit)throw new Error('Commit релиза изменился после просмотра. Проверьте источник заново.');
 const assets=release.assets.map(value=>releaseAsset(value,{...parsed,tag})).filter(Boolean);
 const common={url:source.url,commit,ref:commit,entrypoint:'',candidates:[],name:typeof repository.name==='string'?repository.name:parsed.repository,description:typeof repository.description==='string'?repository.description.slice(0,2000):'',release:{tag,id:release.id},releaseChoices:assets.map(({url,sha256,...asset})=>asset),runnableKinds:['mcp']};
 if(!assets.length)throw new Error('В релизе нет готовых ZIP, TAR.GZ или исполняемых файлов до 256 МиБ. Исходники доступны по ссылке репозитория.');
 const chosen=requested.asset?assets.find(asset=>asset.name===requested.asset):assets.length===1?assets[0]:undefined;
 if(requested.asset&&!chosen)throw new Error('Выбранный файл удалён из релиза. Проверьте источник заново.');
 if(!chosen)return {...common,requiresReleaseChoice:true,warnings:['Выберите готовую поставку релиза. Архивы исходников собираются через репозиторий.']};
 if(requested.assetId&&requested.assetId!==chosen.id||requested.sha256&&chosen.sha256&&requested.sha256!==chosen.sha256)throw new Error('Файл релиза заменён после просмотра. Проверьте источник заново.');
 if(typeof inspectAsset!=='function')throw new Error('Проверка содержимого релиза недоступна. Повторите позже.');
 const inspected=await inspectAsset({...chosen,...(requested.sha256?{sha256:requested.sha256}:{})},source.entrypoint);
 if(!object(inspected)||!/^[a-f0-9]{64}$/.test(inspected.sha256)||!Array.isArray(inspected.candidates)||typeof inspected.entrypoint!=='string')throw new Error('Не удалось проверить содержимое релиза.');
 if(requested.sha256&&requested.sha256!==inspected.sha256)throw new Error('SHA-256 файла релиза изменился после просмотра.');
 const pin={tag,id:release.id,asset:chosen.name,assetId:chosen.id,sha256:inspected.sha256};
 const runtimeSource=inspected.runtimeSource?validateRuntimeSource(inspected.runtimeSource):undefined;
 return {...common,...inspected,release:pin,recommendedKind:'mcp',...(runtimeSource?{runtimeSource,adapter:runtimeSource.adapter,supportedTargets:Object.keys(runtimeSource.assets)}:{}),requiresEntrypointChoice:inspected.candidates.length>1&&!inspected.entrypoint};
}
module.exports={validateReleaseInput,resolveGithubRelease};
