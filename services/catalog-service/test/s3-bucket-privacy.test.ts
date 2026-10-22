import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {Client} from 'minio';
import {assertPrivateS3Bucket} from '../../shared/s3-bucket-privacy.cjs';

const acl=(owner='owned',grantee=owner)=>`<?xml version="1.0"?><AccessControlPolicy xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>${owner}</ID><DisplayName>QA owner</DisplayName></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>${grantee}</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>`;
const named=(principal:unknown)=>JSON.stringify({Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:principal,Action:'s3:GetObject',Resource:'arn:aws:s3:::qa-private/*'}]});
const minio='<AccessControlPolicy><Owner><ID></ID><DisplayName></DisplayName></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><Type>CanonicalUser</Type></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>';
/** Official signing/HTTP parser is real; this peer controls only policy/ACL responses and owns all sockets. */
describe.sequential('Signed bounded S3 policy/ACL privacy admission',()=>{
 let server:Server,client:Client,policy:string|Buffer|null,document:string|Buffer,status:number,requests:Array<{query:string;signed:boolean}>;
 beforeEach(async()=>{
  policy=null;document=acl();status=200;requests=[];
  server=createServer((req,res)=>{const query=new URL(req.url!,'http://fixture').search.slice(1);requests.push({query,signed:/^AWS4-HMAC-SHA256 /.test(String(req.headers.authorization))});
   if(query==='policy'&&policy===null){res.writeHead(404,{'content-type':'application/xml'});res.end('<Error><Code>NoSuchBucketPolicy</Code><Message>No policy</Message></Error>');return;}
   if(query==='policy'){res.writeHead(status,{'content-type':'application/json'});res.end(policy);return;}
   if(query==='acl'){res.writeHead(200,{'content-type':'application/xml'});res.end(document);return;}
   res.writeHead(400).end();
  });server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('Own HTTP address missing.');
  client=new Client({endPoint:'127.0.0.1',port:address.port,useSSL:false,accessKey:'synthetic-access',secretKey:'synthetic-secret',region:'us-east-1',retryOptions:{disableRetry:true}});
 });
 afterEach(async()=>{vi.useRealTimers();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 it('accepts absent policy plus owner-only Ceph-style ACL through real signed HTTP',async()=>{await assertPrivateS3Bucket(client,'qa-private');expect(requests).toEqual([{query:'policy',signed:true},{query:'acl',signed:true}]);});
 it('accepts private MinIO ACL shape and an explicit named AWS role without pretending its ARN equals canonical owner ID',async()=>{policy=named({AWS:['arn:aws:iam::123456789012:role/reader']});document=minio;await assertPrivateS3Bucket(client,'qa-private');expect(requests).toHaveLength(2);});
 it.each([{CanonicalUser:'canonical-reader'},'arn:aws:iam::123456789012:root'])('accepts explicit nonpublic principal %j',async principal=>{policy=named(principal);await assertPrivateS3Bucket(client,'qa-private');});
 it('a deny wildcard does not grant anonymous access',async()=>{policy=JSON.stringify({Statement:[{Effect:'Deny',Principal:'*',Action:'s3:*',Resource:'*'}]});await assertPrivateS3Bucket(client,'qa-private');});
 it.each([{Principal:{AWS:'*'}},{NotPrincipal:{AWS:'arn:aws:iam::123456789012:role/reader'}}])('valid restrictive Deny %j plus named Allow remains private',async restriction=>{policy=JSON.stringify({Statement:[{Effect:'Deny',...restriction,Action:'s3:*',Resource:'*',Condition:{Bool:{'aws:SecureTransport':'false'}}},{Effect:'Allow',Principal:{AWS:'arn:aws:iam::123456789012:role/reader'},Action:'s3:GetObject',Resource:'arn:aws:s3:::qa-private/*'}]});await assertPrivateS3Bucket(client,'qa-private');});
 it.each(['*',{AWS:'*'},{AWS:['arn:aws:iam::123456789012:role/read?']},{AWS:[]},{AWS:123},{Service:'logging.s3.amazonaws.com'},{AWS:'named',CanonicalUser:'other'},123,null,'',{}])('rejects malformed or wildcard principal %j before ACL/body disclosure',async principal=>{policy=named(principal);await expect(assertPrivateS3Bucket(client,'qa-private')).rejects.toThrow('S3_BUCKET_PRIVACY_UNCONFIRMED');expect(requests.map(r=>r.query)).toEqual(['policy']);});
 it.each(['{',JSON.stringify({Statement:[]}),JSON.stringify({Statement:[{Effect:'Allow',NotPrincipal:{AWS:'named'}}]}),JSON.stringify({Statement:[{Effect:'Allow'}]})])('malformed policy fails closed: %s',async value=>{policy=value;await expect(assertPrivateS3Bucket(client,'qa-private')).rejects.toThrow('S3_BUCKET_PRIVACY_UNCONFIRMED');});
 it('a control access denial is not treated as an absent private policy and leaks no response body',async()=>{status=403;policy='<Error><Code>AccessDenied</Code><Message>PRIVATE-BODY</Message></Error>';await expect(assertPrivateS3Bucket(client,'qa-private')).rejects.toThrow(/^S3_BUCKET_PRIVACY_UNCONFIRMED$/);expect(requests).toHaveLength(1);});
 it.each(['<Error><Code>NoSuchPolicy</Code><Code>AccessDenied</Code></Error>','<Error><Code>NoSuchPolicy</Code>','<Error><Code>NoSuchBucket</Code></Error>',''])('malformed/ambiguous404 never proves missing policy: %s',async value=>{status=404;policy=value;await expect(assertPrivateS3Bucket(client,'qa-private')).rejects.toThrow('S3_BUCKET_PRIVACY_UNCONFIRMED');expect(requests).toHaveLength(1);});
 it('recognizes the alternate NoSuchPolicy code only with an exact404 Error response',async()=>{status=404;policy='<Error><Code>NoSuchPolicy</Code><Message>No policy</Message></Error>';await assertPrivateS3Bucket(client,'qa-private');expect(requests.map(r=>r.query)).toEqual(['policy','acl']);});
 it.each([403,500,302])('NoSuchPolicy text with HTTP%s never masquerades as absent policy',async value=>{status=value;policy='<Error><Code>NoSuchPolicy</Code><Message>PRIVATE-BODY</Message></Error>';await expect(assertPrivateS3Bucket(client,'qa-private')).rejects.toThrow(/^S3_BUCKET_PRIVACY_UNCONFIRMED$/);expect(requests).toHaveLength(1);});
 it('an oversized HTTP403 control body is bounded before the SDK error parser can consume it',async()=>{status=403;policy='<Error><Code>AccessDenied</Code><Message>'+('x'.repeat(65537))+'</Message></Error>';await expect(assertPrivateS3Bucket(client,'qa-private')).rejects.toThrow(/^S3_BUCKET_PRIVACY_UNCONFIRMED$/);expect(requests).toHaveLength(1);});
 it.each(['policy','acl'])('invalid UTF-8 in signed %s control data is not accepted via replacement characters',async kind=>{const invalid=Buffer.from([0xc3,0x28]);if(kind==='policy')policy=invalid;else document=invalid;await expect(assertPrivateS3Bucket(client,'qa-private')).rejects.toThrow('S3_BUCKET_PRIVACY_UNCONFIRMED');});
 it.each(['policy','acl'])('bounds actual HTTP %s response before accepting it',async kind=>{if(kind==='policy')policy=' '.repeat(65537);else document=' '.repeat(65537);await expect(assertPrivateS3Bucket(client,'qa-private')).rejects.toThrow('S3_BUCKET_PRIVACY_UNCONFIRMED');});
 it.each([
  ()=>acl('owned','foreign'),
  ()=>acl('own\x00er','own\x00er'),
  ()=>acl().replace('xsi:type="CanonicalUser"','xsi:type="Group"').replace('<ID>owned</ID></Grantee>','<URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee>'),
  ()=>acl().replace('<Permission>FULL_CONTROL</Permission>','<Permission>UNKNOWN</Permission>'),
  ()=>acl().replace('<ID>owned</ID></Grantee>','<ID>owned</ID><ID>foreign</ID></Grantee>'),
  ()=>acl().replace('</AccessControlPolicy>',''),
  ()=>acl().replace('<AccessControlPolicy ','<!DOCTYPE acl [<!ENTITY owner "owned">]><AccessControlPolicy '),
  ()=>acl().replace('<ID>owned</ID></Grantee>','<ID>&owner;</ID></Grantee>'),
  ()=>acl().replace('xsi:type="CanonicalUser"','xsi:type="CanonicalUser" xsi:type="Group"'),
  ()=>minio.replace('<Permission>FULL_CONTROL</Permission>','<Permission>READ</Permission>'),
  ()=>minio.replace('<Type>CanonicalUser</Type>','<Type>CanonicalUser</Type><ID>foreign</ID>'),
 ])('rejects public/foreign/malformed ACL without changing it (%#)',async change=>{document=change();await expect(assertPrivateS3Bucket(client,'qa-private')).rejects.toThrow('S3_BUCKET_PRIVACY_UNCONFIRMED');expect(requests.map(r=>r.query)).toEqual(['policy','acl']);});
 it('closes a stalled control body at the bound, keeping a generic failure',async()=>{
  vi.useFakeTimers();let destroyed=false;const stream=Object.assign(new Readable({read(){},destroy(error,done){destroyed=true;done(error);}}),{statusCode:200});
  const check=assertPrivateS3Bucket({makeRequestAsync:async()=>stream},'qa-private');const rejected=expect(check).rejects.toThrow('S3_BUCKET_PRIVACY_UNCONFIRMED');await vi.advanceTimersByTimeAsync(30000);await rejected;expect(destroyed).toBe(true);
 });
});
