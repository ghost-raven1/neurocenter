'use strict';

const failure=()=>new Error('S3_BUCKET_PRIVACY_UNCONFIRMED');
const maximum=65536;
const statuses=Array.from({length:500},(_,index)=>100+index);
/** Signed control reads remain bounded; neither credentials nor policy/ACL bodies appear in failures. */
async function control(client,bucket,query){
 let stream;
 try{stream=await client.makeRequestAsync({method:'GET',bucketName:bucket,query},'',statuses);}
 catch{throw failure();}
 const chunks=[];let bytes=0;const timer=setTimeout(()=>stream.destroy(failure()),30000);timer.unref();
 try{for await(const part of stream){const chunk=Buffer.from(part);bytes+=chunk.length;if(bytes>maximum)throw failure();chunks.push(chunk);}
  const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
  if(stream.statusCode===200)return text;
  if(query==='policy'&&stream.statusCode===404){const root=aclTree(text);if(root?.name==='Error'&&['NoSuchBucketPolicy','NoSuchPolicy'].includes(leaf(child(root,'Code'))))return null;}
  throw failure();}
 catch{throw failure();}finally{clearTimeout(timer);stream.destroy();}
}
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const explicit=value=>typeof value==='string'&&value.length>0&&value===value.trim()&&!/[\x00-\x1f\x7f*?]/.test(value);
const names=value=>Array.isArray(value)?value.length>0&&value.every(explicit):explicit(value);
function privatePolicy(text){
 if(text===null)return;
 let policy;try{policy=JSON.parse(text);}catch{throw failure();}
 const statements=object(policy)&&policy.Statement,rows=Array.isArray(statements)?statements:[statements];
 if(!rows.length||rows.some(row=>!object(row)||!['Allow','Deny'].includes(row.Effect)))throw failure();
 for(const row of rows){
  if(row.Effect==='Deny')continue; // A Deny (including TLS enforcement/NotPrincipal) cannot grant public access.
  if('NotPrincipal'in row||!('Principal'in row))throw failure();
  const principal=row.Principal;
  if(typeof principal==='string'){if(!explicit(principal))throw failure();continue;}
  if(!object(principal)||Object.keys(principal).length!==1||!['AWS','CanonicalUser'].includes(Object.keys(principal)[0])||!names(Object.values(principal)[0]))throw failure();
 }
}
function decoded(value){
 const result=value.replace(/&(?:amp|lt|gt|quot|apos);/g,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"})[entity]);
 if(/&[^\s;]*;/.test(result))throw failure();return result;
}
/** Only the small S3 ACL grammar is accepted; DTDs, groups, unknown elements and duplicate grants cannot hide access. */
function aclTree(xml){
 if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(xml))throw failure();
 xml=xml.replace(/^\s*<\?xml\s[^?]*\?>/,'');if(/<!|<\?/.test(xml))throw failure();
 const stack=[],roots=[];let consumed='';
 for(const token of xml.match(/<[^>]*>|[^<]+/g)||[]){consumed+=token;
  if(!token.startsWith('<')){if(stack.length)stack.at(-1).text+=decoded(token);else if(token.trim())throw failure();continue;}
  if(token.startsWith('</')){const match=/^<\/([A-Za-z_][\w:.-]*)\s*>$/.exec(token);if(!match||stack.pop()?.tag!==match[1])throw failure();continue;}
  const match=/^<([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/.exec(token);if(!match)throw failure();
  const attrs={},remaining=match[2].replace(/\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,(_,name,double,single)=>{if(name in attrs)throw failure();attrs[name]=decoded(double??single);return '';});if(remaining.trim())throw failure();
  const node={tag:match[1],name:match[1].split(':').at(-1),attrs,children:[],text:''};if(stack.length)stack.at(-1).children.push(node);else roots.push(node);if(!match[3])stack.push(node);
 }
 if(consumed!==xml||stack.length||roots.length!==1)return null;return roots[0];
}
const child=(node,name)=>{const rows=node.children.filter(row=>row.name===name);if(rows.length!==1)throw failure();return rows[0];};
function fields(node,allowed){if(node.text.trim()||node.children.some(row=>!allowed.includes(row.name))||new Set(node.children.map(row=>row.name)).size!==node.children.length)throw failure();}
function leaf(node){if(node.children.length||Object.keys(node.attrs).some(key=>key!=='xmlns'&&!key.startsWith('xmlns:')))throw failure();return node.text.trim();}
function privateAcl(text){
 const root=aclTree(text);if(!root||root.name!=='AccessControlPolicy')throw failure();fields(root,['Owner','AccessControlList']);
 const owner=child(root,'Owner');fields(owner,['ID','DisplayName']);const ownerId=leaf(child(owner,'ID'));
 const list=child(root,'AccessControlList');if(list.text.trim()||!list.children.length||list.children.some(row=>row.name!=='Grant'))throw failure();
 for(const grant of list.children){
  fields(grant,['Grantee','Permission']);const permission=leaf(child(grant,'Permission'));if(!['FULL_CONTROL','READ','WRITE','READ_ACP','WRITE_ACP'].includes(permission))throw failure();
  const grantee=child(grant,'Grantee');fields(grantee,['ID','DisplayName','Type']);
  const types=Object.entries(grantee.attrs).filter(([key])=>key==='type'||key.endsWith(':type'));if(types.length!==1||types[0][1]!=='CanonicalUser'||Object.keys(grantee.attrs).some(key=>key!=='type'&&!key.endsWith(':type')&&key!=='xmlns'&&!key.startsWith('xmlns:')))throw failure();
  const type=grantee.children.find(row=>row.name==='Type');if(type&&leaf(type)!=='CanonicalUser')throw failure();
  const id=grantee.children.find(row=>row.name==='ID'),granteeId=id?leaf(id):null;
  if(ownerId){if(granteeId!==ownerId)throw failure();}
  else if(list.children.length!==1||granteeId!==null||permission!=='FULL_CONTROL')throw failure();
 }
}
/** Confirms no anonymous/group grants. Explicit named policy principals are allowed; this does not claim IAM-to-owner identity mapping. */
async function assertPrivateS3Bucket(client,bucket){
 try{privatePolicy(await control(client,bucket,'policy'));privateAcl(await control(client,bucket,'acl'));}
 catch{throw failure();}
}
module.exports={assertPrivateS3Bucket};
