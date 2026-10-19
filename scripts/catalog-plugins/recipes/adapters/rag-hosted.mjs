import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {embeddingSignature,normalizeIndexProfile} from '../../../../services/shared/rag-index-contract.cjs';
const hostedIdentity=Symbol.for('neurocenter.hosted-rag');
const sha=value=>createHash('sha256').update(value).digest('hex');
const failure=()=>new Error('Приватное подключение OpenCodeRAG повреждено или изменилось. Подключите модель проекта повторно через мост.');
function json(file,missing=false){try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>8*1024*1024)throw failure();return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(missing&&error.code==='ENOENT')return undefined;throw failure();}}
function checkedDirectory(directory,privateMode=false){const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||privateMode&&process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid?.()))throw failure();return stat;}
function readPrivate(file){
 let before;try{before=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return undefined;throw failure();}
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>8*1024*1024||process.platform!=='win32'&&((before.mode&0o077)!==0||before.uid!==process.getuid?.()))throw failure();
 if(process.platform==='win32'){
  const script='$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$acl=Get-Acl -LiteralPath $env:NEUROCENTER_PRIVATE_ACL_PATH;if(-not $acl.AreAccessRulesProtected){exit 2};if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid){exit 3};foreach($rule in $acl.Access){if($rule.AccessControlType -eq "Allow" -and $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid){exit 4}}';
  try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:5000,windowsHide:true,stdio:'ignore',env:{...process.env,NEUROCENTER_PRIVATE_ACL_PATH:file}});}catch{throw failure();}
 }
 let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const opened=fs.fstatSync(fd);if(opened.ino!==before.ino||opened.dev!==before.dev)throw failure();const text=fs.readFileSync(fd,'utf8');const after=fs.fstatSync(fd),named=fs.lstatSync(file);if(opened.size!==Buffer.byteLength(text)||opened.size!==after.size||opened.mtimeMs!==after.mtimeMs||opened.ctimeMs!==after.ctimeMs||named.ino!==opened.ino||named.dev!==opened.dev)throw failure();return JSON.parse(text);}finally{if(fd!==undefined)fs.closeSync(fd);}
}
/** Непереносимый в JSON marker появляется только после проверки private-store. */
export function hostedRagIdentity(config){
 const signature=config?.[hostedIdentity];if(signature===undefined)return undefined;
 const embedding=config.embedding,profile=normalizeIndexProfile({provider:embedding?.provider,model:embedding?.model,dimension:embedding?.vectorDimension});
 if(signature!==embeddingSignature(profile,embedding.baseUrl))throw failure();return signature;
}
/** Upstream structuredClone теряет Symbol: возвращаем проверенную identity после runtime overrides. */
export function preserveHostedRagConfiguration(source,target){
 const signature=hostedRagIdentity(source);if(!signature)return target;
 target.embedding={...target.embedding,...source.embedding};target.indexing={...target.indexing,embedBatchSize:8,embedConcurrency:1};
 if(source.openCode?.autoIndex?.enabled===false)target.openCode={...target.openCode,autoIndex:{...target.openCode?.autoIndex,enabled:false}};
 Object.defineProperty(target,hostedIdentity,{value:signature,enumerable:true,configurable:true});return target;
}
function workspaceStore(config,root){
 const store=path.resolve(root,config.vectorStore?.path??'.opencode/rag_db'),relative=path.relative(root,store);
 if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw failure();return store;
}
function registeredHosted(state,key,root,instanceId){
 const registry=json(path.join(state,'rag-hosted-connections.json'),true);if(registry===undefined)return false;
 if(!Array.isArray(registry)||registry.length>128||registry.some(key=>typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key)))throw failure();
 if(registry.includes(key))return true;
 return registry.some(saved=>{const prior=readPrivate(path.join(state,'local-configuration',saved+'.json'));return prior?.schemaVersion===1&&(prior.root===root||prior.instanceId===instanceId);});
}
/** Закреплённый адаптер выводит private-store из своего артефакта, а не из env дочернего процесса. */
export function applyHostedRagConfiguration(config,root){
 if(!root)return config;
 root=fs.realpathSync(root);const store=workspaceStore(config,root);let provenance;try{provenance=json(path.join(store,'neurocenter-index-profile.json'),true);}catch{provenance=undefined;}
 const hadHostedIndex=typeof provenance?.profile?.model==='string'&&/^neurocenter\/[^/]+\/sha256\/[a-f0-9]{64}$/.test(provenance.profile.model);
 const artifact=path.dirname(fileURLToPath(import.meta.url));if(!/^[a-f0-9]{64}$/.test(path.basename(artifact))||path.basename(path.dirname(artifact))!=='runtime-artifacts'){if(hadHostedIndex)throw failure();return config;}
 const markerPath=path.join(root,'.opencode/neurocenter.json');let markerStat;try{markerStat=fs.lstatSync(markerPath);}catch(error){if(error.code==='ENOENT'&&!hadHostedIndex&&!registeredHosted(path.dirname(path.dirname(artifact)),'',root,undefined))return config;throw failure();}if(!markerStat.isFile()||markerStat.isSymbolicLink())throw failure();const marker=json(markerPath);
 if(marker.version!==2||typeof marker.server!=='string'||typeof marker.instanceId!=='string'||typeof marker.projectId!=='string')throw failure();
 const state=path.dirname(path.dirname(artifact)),directory=path.join(state,'local-configuration');
 try{if(new URL(marker.server).origin!==marker.server||path.basename(state)!==sha(marker.server).slice(0,20))throw failure();}catch{throw failure();}
 const key=sha(JSON.stringify([marker.server,root,marker.instanceId]));
 const requirePrevious=()=>hadHostedIndex||registeredHosted(state,key,root,marker.instanceId);
 try{checkedDirectory(state);checkedDirectory(path.dirname(artifact));checkedDirectory(artifact);checkedDirectory(directory,true);}catch(error){if(error.code==='ENOENT'&&!requirePrevious())return config;throw failure();}
 const value=readPrivate(path.join(directory,key+'.json'));if(!value){if(requirePrevious())throw failure();return config;}
 const {selection,relay,pkg}=value;const profile=normalizeIndexProfile(selection?.profile);
 if(value.schemaVersion!==1||value.server!==marker.server||value.root!==root||value.projectId!==marker.projectId||value.instanceId!==marker.instanceId||!Number.isSafeInteger(selection?.revision)||selection.revision<1||!/^[a-f0-9]{64}$/.test(selection.modelPin)||profile?.provider!=='openai'||!profile.model.endsWith('/sha256/'+selection.modelPin)
  ||!Number.isSafeInteger(relay?.port)||relay.port<1||relay.port>65535||!/^[a-f0-9]{64}$/.test(relay.key)||pkg?.config?.extra?.hostedEmbedding?.schemaVersion!==1||!pkg.config.extra.runtimeArtifacts?.some(entry=>entry.sha256===path.basename(artifact)))throw failure();
 const receipt=json(path.join(root,'.opencode/neurocenter/receipts',sha(pkg.plugin.kind+':'+pkg.plugin.id).slice(0,24)+'.json'),true);
 if(receipt?.manifest!==pkg.manifest.sha256||receipt?.version!==pkg.plugin.version)throw failure();
 const baseUrl=`http://127.0.0.1:${relay.port}/v1`;const result=structuredClone(config);
 result.embedding={...result.embedding,provider:'openai',model:profile.model,vectorDimension:profile.dimension,baseUrl,apiKey:relay.key,timeoutMs:120000};
 result.indexing={...result.indexing,embedBatchSize:8,embedConcurrency:1};
 // Подключение не даёт согласия на перестроение прежнего индекса при следующем запуске OpenCode.
 if(provenance?.schemaVersion!==1||provenance.state!=='ready'||provenance.embeddingSignature!==embeddingSignature(profile,baseUrl))result.openCode={...result.openCode,autoIndex:{...result.openCode?.autoIndex,enabled:false}};
 Object.defineProperty(result,hostedIdentity,{value:embeddingSignature(profile,baseUrl),enumerable:true,configurable:true});
 return result;
}
