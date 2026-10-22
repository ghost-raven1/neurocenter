import {mkdtemp,realpath,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash,createHmac} from 'node:crypto';
import {chatRecoveryHash} from '../production/chat-recovery-config.mjs';
import {chatObjectKey,chatMetadata} from '../production/chat-recovery-metadata.mjs';

export const ids=Array.from({length:12},(_,i)=>'12345678-1234-4234-8234-'+String(i+1).padStart(12,'0'));
export const payload=Buffer.from('Exact private chat original 日本語');
export async function temporary(action){const root=await realpath(await mkdtemp(path.join(tmpdir(),'nc-chat-recovery-')));try{return await action(root);}finally{await rm(root,{recursive:true,force:true});}}
export async function configuration(root,endpoint,{source=true,target=true}={}){
 await writeFile(path.join(root,'access'),'test-access',{mode:0o600});await writeFile(path.join(root,'secret'),'test-secret',{mode:0o600});
 const entry=(projectBucket,personalBucket)=>({endpoint,projectBucket,personalBucket,region:'us-east-1',accessKeyFile:'access',secretKeyFile:'secret'}),raw={...(source?{source:entry('chat-source-project','chat-source-personal')}:{}),...(target?{target:entry('chat-target-project','chat-target-personal')}:{})};
 await writeFile(path.join(root,'chat-recovery.json'),JSON.stringify(raw),{mode:0o600});return raw;
}
export function rows(source,{versions=['old-project',null],transfers=true,discarded=true}={}){
 const objects=[0,1].map(index=>({id:ids[index],storageId:source.storageId,bucket:index?source.personalBucket:source.projectBucket,objectKey:chatObjectKey(index?null:'prj-test',index?'personal@test':'project@test',ids[4+index],ids[index]),versionId:versions[index],sha256:chatRecoveryHash(payload),bytes:payload.length,state:'LIVE'}));
 const conversations=[{id:ids[4],ownerEmail:'project@test',projectId:'prj-test'},{id:ids[5],ownerEmail:'personal@test',projectId:null}];
 const attachments=objects.map((row,index)=>({id:ids[2+index],conversationId:ids[4+index],objectId:row.id,storageState:'S3',bytes:row.bytes,deletedAt:null}));
 if(discarded)for(const[index,state]of ['STAGING','DELETE'].entries())objects.push({...objects[0],id:ids[8+index],objectKey:chatObjectKey('prj-test','project@test',ids[4],ids[8+index]),versionId:index?'orphan-old':null,state});
 const transferRows=[];if(transfers)for(let index=0;index<2;index++){attachments.push({id:ids[6+index],conversationId:ids[4+index],objectId:null,storageState:index?'DELETED':'TRANSFER',bytes:payload.length,deletedAt:index?'2026-10-22T00:00:00Z':null});transferRows.push({attachmentId:ids[6+index],sha256:chatRecoveryHash(payload),bytes:payload.length,contentSha256:chatRecoveryHash(payload),contentBytes:payload.length});}
 return{objects,attachments,conversations,transfers:transferRows};
}
export function sqlRows(raw,{absent=false,onPublication=()=>{}}={}){return async(_db,text)=>{
 if(text.includes('to_regclass'))return absent?'f':'t';
 if(text.startsWith('BEGIN;')){await onPublication(text);return '';}
 for(const[table,key]of [['model_chat_objects','objects'],['model_chat_attachments','attachments'],['model_chat_conversations','conversations'],['model_chat_attachment_transfers','transfers']])if(text.endsWith('FROM '+table+';'))return JSON.stringify(raw[key]);
 throw Error('Unexpected SQL fixture: '+text);
};}
export const metadata=raw=>chatMetadata(structuredClone(raw));
export async function bundle(root,inventory){for(const row of inventory.objects){await mkdir(path.join(root,'chat-objects'),{mode:0o700,recursive:true});await writeFile(path.join(root,row.file),payload,{mode:0o600});}}
const hmac=(key,text)=>createHmac('sha256',key).update(text).digest();
const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
function authenticated(request){
 const match=/^AWS4-HMAC-SHA256 Credential=test-access\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(request.headers.authorization||'');if(!match)return false;
 const url=new URL(request.url,'http://fixture'),headers=match[2].split(';').map(key=>key+':'+String(request.headers[key]||'').trim().replace(/\s+/g,' ')+'\n').join(''),query=[...url.searchParams].map(([key,value])=>[encode(key),encode(value)]).sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1])).map(row=>row.join('=')).join('&');
 const canonical=[request.method,url.pathname,query,headers,match[2],request.headers['x-amz-content-sha256']].join('\n'),scope=match[1].split('/');
 let key=hmac('AWS4test-secret',scope[0]);for(const part of scope.slice(1))key=hmac(key,part);
 const text=['AWS4-HMAC-SHA256',request.headers['x-amz-date'],match[1],createHash('sha256').update(canonical).digest('hex')].join('\n');return createHmac('sha256',key).update(text).digest('hex')===match[3];
}
/** Small signed-HTTP S3 protocol fixture; no container, external service or shared bucket. */
export async function s3Fixture(action){
 const buckets=new Map(),events=[],publicVersions=new Set();let sequence=0,hook=async()=>{},mode='ok';
 const xml=(response,status,body,headers={})=>{response.writeHead(status,{'content-type':'application/xml',...headers});response.end(body);};
 const error=(response,code,status=404)=>xml(response,status,'<Error><Code>'+code+'</Code><Message>Owned fixture</Message></Error>');
 const server=createServer(async(request,response)=>{try{
  const url=new URL(request.url,'http://fixture'),parts=url.pathname.slice(1).split('/'),bucket=parts.shift(),key=parts.join('/'),signed=authenticated(request);events.push({method:request.method,bucket,key,version:url.searchParams.get('versionId'),signed,query:url.search});await hook({request,response,url,bucket,key,signed});if(response.writableEnded)return;
  if(!signed){if(request.headers.authorization)return error(response,'SignatureDoesNotMatch',403);if(mode==='stall-head')return;response.writeHead(publicVersions.has(bucket+'\0'+key+'\0'+url.searchParams.get('versionId'))?200:403);response.end();return;}
  const data=buckets.get(bucket);
  if(url.searchParams.has('policy'))return error(response,'NoSuchBucketPolicy');
  if(url.searchParams.has('acl'))return xml(response,200,'<AccessControlPolicy><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>');
  if(url.searchParams.has('versioning')){if(!data)return error(response,'NoSuchBucket');if(request.method==='PUT'){for await(const _ of request){}data.versioned=true;return xml(response,200,'');}return xml(response,200,'<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>'+(data.versioned?'Enabled':'Suspended')+'</Status></VersioningConfiguration>');}
  if(url.searchParams.has('versions')){if(!data)return error(response,'NoSuchBucket');const versions=[...data.objects].map(([name,items])=>items.map(item=>'<Version><Key>'+name+'</Key><VersionId>'+item.version+'</VersionId><IsLatest>true</IsLatest><LastModified>2026-10-22T00:00:00Z</LastModified><ETag>"abc"</ETag><Size>'+item.bytes.length+'</Size><StorageClass>STANDARD</StorageClass></Version>').join('')).join('');return xml(response,200,'<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>'+bucket+'</Name><Prefix></Prefix><KeyMarker></KeyMarker><VersionIdMarker></VersionIdMarker><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>'+versions+'</ListVersionsResult>');}
  if(!key){if(request.method==='HEAD'){response.writeHead(data?200:404);response.end();return;}if(request.method==='PUT'){for await(const _ of request){}if(data)return error(response,'BucketAlreadyOwnedByYou',409);buckets.set(bucket,{versioned:false,objects:new Map()});if(mode==='unknown-create'){response.destroy();return;}return xml(response,200,'');}}
  if(!data)return error(response,'NoSuchBucket');
  if(request.method==='PUT'){const chunks=[];for await(const chunk of request)chunks.push(chunk);const bytes=Buffer.concat(chunks),version='target-version-'+(++sequence),items=data.objects.get(key)||[];items.push({version,bytes});data.objects.set(key,items);if(mode==='unknown-put'){response.destroy();return;}return xml(response,200,'',{etag:'"'+createHash('md5').update(bytes).digest('hex')+'"','x-amz-version-id':version});}
  if(request.method==='GET'||request.method==='HEAD'){const item=(data.objects.get(key)||[]).find(item=>item.version===(url.searchParams.get('versionId')??'null'));if(!item)return error(response,'NoSuchVersion');const returned=mode==='wrong-version'?'changed':item.version;response.writeHead(200,{'content-length':item.bytes.length,'x-amz-version-id':returned,'content-type':'application/octet-stream'});if(mode==='stall-body'){response.write(item.bytes.subarray(0,1));return;}response.end(mode==='wrong-bytes'?Buffer.alloc(item.bytes.length,1):item.bytes);return;}
  return error(response,'NotImplemented',501);
 }catch(failure){error(response,'FixtureError',500);}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const api={endpoint:'http://127.0.0.1:'+server.address().port,buckets,events,publicVersions,setHook:value=>{hook=value;},setMode:value=>{mode=value;},seed(source,raw){for(const bucket of [source.projectBucket,source.personalBucket])buckets.set(bucket,{versioned:true,objects:new Map()});for(const row of raw.objects.filter(row=>row.state==='LIVE'))buckets.get(row.bucket).objects.set(row.objectKey,[{version:row.versionId??'null',bytes:payload}]);}};
 try{return await action(api);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
