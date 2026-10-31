import {createHash} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {proxyHttpFixture,browserHeaders,jobId} from './proxy-http.fixture';

describe.sequential('Actual Proxy raw and binary dispatch',()=>{
 let f:Awaited<ReturnType<typeof proxyHttpFixture>>;beforeEach(async()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-proxy-internal');f=await proxyHttpFixture();});afterEach(async()=>{await f.close();vi.unstubAllEnvs();});
 it.each(['/api/tool-builds/uploads/'+jobId+'/content','/api/asset-sources/archive','/api/projects/prj-qa/snapshot-uploads/'+jobId+'/blobs/'+'a'.repeat(64)])('streams %s through fresh authorization with exact raw bytes',async route=>{
  const response=await fetch(f.url+route,{method:'PUT',headers:{...browserHeaders,'content-type':'application/octet-stream'},body:Buffer.from([0,1,2,255])});expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,bytes:4});expect(f.business()[0].path).toBe(route);expect(f.calls.some(call=>call.path==='/internal/access/authorize')).toBe(true);expect(response.headers.get('cache-control')).toBe('no-store');
 });
 it('rejects wrong upload media before any data-plane request',async()=>{
  const route='/api/tool-builds/uploads/'+jobId+'/content';expect((await f.send(route,{method:'PUT',body:{bad:'JSON'}})).status).toBe(415);expect(f.business()).toEqual([]);
 });
 it.each(['supply','asset'])('preserves exact tool %s bytes rather than JSON-reserializing a document',async kind=>{
  const bytes=kind==='asset'?Buffer.from('{"exact":true}\n'):Buffer.from('bytes');f.state.handler=(_req,res)=>{res.writeHead(200,{'content-length':String(bytes.length),'content-type':kind==='asset'?'application/json; charset=utf-8':'application/gzip',...(kind==='supply'?{'content-disposition':'attachment; filename="verified.tar.gz"'}:{})});res.end(bytes);};
  const response=await fetch(f.url+'/api/tool-builds/'+jobId+'/'+kind,{headers:browserHeaders});expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);expect(response.headers.get('cache-control')).toBe('no-store');
 });
 it('routes tool readiness HEAD without transferring a supply body',async()=>{
  f.state.handler=(_req,res)=>{res.writeHead(204);res.end();};expect((await f.send('/api/tool-builds/'+jobId+'/supply',{method:'HEAD'})).status).toBe(204);
 });
 it('streams a snapshot block only under its exact length and SHA',async()=>{
  const bytes=Buffer.from('snapshot bytes'),sha=createHash('sha256').update(bytes).digest('hex');f.state.handler=(_req,res)=>{res.writeHead(200,{'content-length':String(bytes.length)});res.end(bytes);};const route='/api/projects/prj-qa/versions/'+jobId+'/blobs/'+sha;
  const response=await fetch(f.url+route,{headers:browserHeaders});expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);expect(f.business()[0].path).toBe(route);
 });
 it('routes a backup download and copies only allowed range metadata',async()=>{
  f.state.handler=(_req,res)=>{res.writeHead(206,{'content-length':'4','content-type':'application/octet-stream','content-disposition':'attachment; filename="backup.bin"','accept-ranges':'bytes','content-range':'bytes 0-3/10','x-private':'must not reach browser'});res.end('data');};const result=await f.send('/api/projects/prj-qa/backups/qa/download',{headers:{range:'bytes=0-3'}});expect(result.status).toBe(206);expect(result.body).toBe('data');expect(result.headers.get('content-range')).toBe('bytes 0-3/10');expect(result.headers.get('x-private')).toBeNull();
 });
 it.each([['POST','/api/bridge-source/check'],['GET','/api/tool-builds/repository'],['GET','/api/tool-builds/npm']])('keeps source inspection %s %s on its authenticated control plane',async(method,route)=>{
  expect((await f.send(route,{method,body:method==='POST'?{}:undefined})).status).toBe(200);expect(f.business()[0].path).toBe(route);
 });
 it('routes exact build name discovery to Catalog with query and fresh authorization',async()=>{
  const target={catalogId:'native-tool',kind:'mcp',name:'Tool & MCP',archived:false};f.state.businessPayload=target;
  const response=await f.send('/api/tool-builds/publication-conflict?name=Tool%20%26%20MCP');
  expect(response.status).toBe(200);expect(response.body).toEqual(target);
  expect(f.business()).toHaveLength(1);expect(f.business()[0]).toMatchObject({kind:'catalog',path:'/api/tool-builds/publication-conflict',method:'GET'});
  expect(new URL(f.business()[0].url,'http://fixture').searchParams.get('name')).toBe(target.name);
  expect(f.calls.some(call=>call.path==='/internal/access/authorize')).toBe(true);
 });
 it('denied build name discovery never reaches Catalog business data',async()=>{
  f.state.allowed=false;expect((await f.send('/api/tool-builds/publication-conflict?name=Tool')).status).toBe(403);expect(f.business()).toEqual([]);
 });
 it('keeps non-JSON content types and deliberately empty non-JSON null responses intact',async()=>{
  f.state.handler=(_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('null');};const response=await fetch(f.url+'/api/projects',{headers:browserHeaders});expect(response.status).toBe(200);expect(response.headers.get('content-type')).toMatch(/text\/plain/);expect(await response.text()).toBe('');
 });
});
