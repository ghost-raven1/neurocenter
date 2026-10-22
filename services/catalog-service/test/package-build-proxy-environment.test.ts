import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {rootCertificates} from 'node:tls';
import type {ChildProcess,SpawnOptions} from 'node:child_process';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {BuildConfiguration} from '../src/package-build/package-build.model';

const children=vi.hoisted(()=>[] as Array<{child:ChildProcess;closed:Promise<void>}>);
vi.mock('node:child_process',async original=>{
    const actual=await original<typeof import('node:child_process')>();
    return {...actual,spawn:(command:string,args:string[],options:SpawnOptions)=>{
        // Only relocate our unchanged guardian source: this test does not run the package builder or extension code.
        if(args[0]!=='--require'||!args[1].endsWith('/package-build/build-guardian.js'))throw Error('Unexpected child startup');
        const child=actual.spawn(command,['--require',args[1].replace(/\.js$/,'.ts'),...args.slice(2)],options);
        children.push({child,closed:new Promise(resolve=>child.once('close',()=>resolve()))});return child;
    }};
});
import {runPackageBuilder} from '../src/package-build/build-process';

const proxyKeys=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'];
const inspected=[...proxyKeys,'NODE_USE_ENV_PROXY','NODE_EXTRA_CA_CERTS','NPM_CLI_JS','HOME','USERPROFILE','TMPDIR','TMP','TEMP',
    'CATALOG_PG_URL','NEUROCENTER_INTERNAL_TOKEN','NODE_OPTIONS','NODE_TLS_REJECT_UNAUTHORIZED','npm_config_userconfig'];
const config:BuildConfiguration={kind:'plugin',name:'Owned proxy boundary',description:'No extension execution',targets:['darwin-arm64'],tags:[],
    source:{type:'files',entrypoint:'index.mjs',files:[{path:'index.mjs',content:'export default()=>({})'}]}};
const script=`import fs from 'node:fs/promises';
const probe=JSON.parse(await fs.readFile('probe.json','utf8'));
await fs.writeFile('child-environment.json',JSON.stringify(Object.fromEntries(probe.names.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))),{mode:0o600});
if(probe.url){try{const response=await fetch(probe.url,{signal:AbortSignal.timeout(2000)});const body=await response.text();
if(!response.ok||body!=='OWNED_DEPENDENCY')throw Error('Dependency unavailable');await fs.writeFile('dependency.json',JSON.stringify({status:response.status,body}),{mode:0o600});}
catch{console.error('PRIVATE proxy user:owned-secret http://fixture.invalid/?token=owned-secret');process.exitCode=1;}}
`;
interface ProxyFixture {url:string;proxy:string;state:{tunnels:number;direct:number;proxied:number;foreign:number;refuse:boolean};close:()=>Promise<void>;sockets:()=>number;listening:()=>boolean}
/** Both endpoints are owned loopback ports; the proxy refuses every destination except this exact target. */
async function loopbackProxy():Promise<ProxyFixture>{
    const sockets=new Set<net.Socket>(),ports=new Set<number>(),state={tunnels:0,direct:0,proxied:0,foreign:0,refuse:false};
    const own=(socket:net.Socket)=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));};
    const target=http.createServer((req,res)=>{const proxied=ports.has(req.socket.remotePort!);if(proxied)state.proxied++;else state.direct++;
        res.writeHead(proxied?200:403,{'connection':'close'});res.end(proxied?'OWNED_DEPENDENCY':'DIRECT_DENIED');});
    target.on('connection',own);await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));
    const port=(target.address() as net.AddressInfo).port;
    const proxy=http.createServer((_req,res)=>{state.foreign++;res.writeHead(403).end();});proxy.on('connection',own);
    proxy.on('connect',(req,socket,head)=>{
        if(req.url!=='127.0.0.1:'+port){state.foreign++;socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
        state.tunnels++;
        if(state.refuse){state.refuse=false;socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
        const outgoing=net.connect(port,'127.0.0.1',()=>{ports.add(outgoing.localPort!);socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)outgoing.write(head);socket.pipe(outgoing);outgoing.pipe(socket);});
        own(outgoing);outgoing.on('error',()=>socket.destroy());socket.on('error',()=>outgoing.destroy());socket.once('close',()=>outgoing.destroy());
    });
    await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
    return{url:'http://127.0.0.1:'+port,proxy:'http://127.0.0.1:'+(proxy.address() as net.AddressInfo).port,state,sockets:()=>sockets.size,listening:()=>target.listening||proxy.listening,
        close:async()=>{for(const socket of sockets)socket.destroy();await Promise.all([target,proxy].map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));await new Promise(resolve=>setImmediate(resolve));}};
}
describe('Builder child keeps only configured proxy transport and private process context',()=>{
    let root:string;const servers:ProxyFixture[]=[];
    beforeEach(async()=>{
        root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-build-proxy-'));
        for(const key of inspected)vi.stubEnv(key,undefined);
        const builder=path.join(root,'owned-child.mjs');await fs.writeFile(builder,script,{mode:0o600});vi.stubEnv('TOOL_BUILD_SCRIPT',builder);
    });
    afterEach(async()=>{
        const pids=children.splice(0);for(const {child}of pids)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
        await Promise.all(pids.map(row=>row.closed));for(const server of servers)await server.close();
        const clean=servers.every(server=>!server.listening()&&server.sockets()===0),proxyStates=servers.map(server=>({...server.state}));servers.length=0;
        await fs.rm(root,{recursive:true,force:true});
        const exited=pids.every(({child})=>{try{process.kill(child.pid!,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;return true;}});
        if(process.env.PACKAGE_PROXY_TEST_CLEANUP)await fs.appendFile(process.env.PACKAGE_PROXY_TEST_CLEANUP,JSON.stringify({root,removed:await fs.stat(root).then(()=>false,()=>true),clean,exited,pids:pids.map(row=>row.child.pid),proxyStates})+'\n');
        vi.unstubAllEnvs();expect(clean).toBe(true);expect(exited).toBe(true);
    });
    async function child(url?:string){const stage=await fs.mkdtemp(path.join(root,'stage-'));await fs.writeFile(path.join(stage,'probe.json'),JSON.stringify({names:inspected,...url?{url}:{}}));
        return{stage,run:()=>runPackageBuilder(config,stage,()=>{}),env:()=>fs.readFile(path.join(stage,'child-environment.json'),'utf8').then(text=>JSON.parse(text) as Record<string,string>)};}
    async function server(){const result=await loopbackProxy();servers.push(result);return result;}
    it('Preserves all eight proxy spellings, valid Node opt-in and CA/npm paths without the service secrets or caller HOME',async()=>{
        const values=Object.fromEntries(proxyKeys.map((key,index)=>[key,key.toLowerCase()==='no_proxy'?'private.test':'http://owned-user:owned-password@127.0.0.1:'+(20000+index)]));
        for(const [key,value]of Object.entries(values))vi.stubEnv(key,value);vi.stubEnv('NODE_USE_ENV_PROXY','1');
        const ca=path.join(root,'corporate-ca.pem'),npm=path.join(root,'owned-npm.cjs');await fs.writeFile(ca,rootCertificates[0]);
        vi.stubEnv('NODE_EXTRA_CA_CERTS',ca);vi.stubEnv('NPM_CLI_JS',npm);vi.stubEnv('HOME',path.join(root,'caller-home'));vi.stubEnv('USERPROFILE',path.join(root,'caller-profile'));
        for(const key of ['CATALOG_PG_URL','NEUROCENTER_INTERNAL_TOKEN','npm_config_userconfig'])vi.stubEnv(key,'OWNED_SERVER_SECRET');
        vi.stubEnv('NODE_OPTIONS','--require /owned-must-not-load.cjs');vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED','0');
        const probe=await child();await expect(probe.run()).resolves.toBe(path.join(probe.stage,'output/asset.json'));const actual=await probe.env();
        expect(actual).toEqual({...values,NODE_USE_ENV_PROXY:'1',NODE_EXTRA_CA_CERTS:ca,NPM_CLI_JS:npm,HOME:path.join(probe.stage,'home'),USERPROFILE:path.join(probe.stage,'home'),
            TMPDIR:path.join(probe.stage,'tmp'),TMP:path.join(probe.stage,'tmp'),TEMP:path.join(probe.stage,'tmp')});
    });
    it.each(['HTTP_PROXY','http_proxy'])('Native child fetch reaches its dependency through %s instead of the denied direct path',async key=>{
        const f=await server();vi.stubEnv(key,f.proxy);vi.stubEnv('NODE_USE_ENV_PROXY','1');const probe=await child(f.url);
        await expect(probe.run()).resolves.toBe(path.join(probe.stage,'output/asset.json'));
        expect(JSON.parse(await fs.readFile(path.join(probe.stage,'dependency.json'),'utf8'))).toEqual({status:200,body:'OWNED_DEPENDENCY'});
        expect(f.state).toEqual({tunnels:1,proxied:1,direct:0,foreign:0,refuse:false});
    });
    it.each(['NO_PROXY','no_proxy'])('Native child honors %s bypass without silently forcing every request through the proxy',async key=>{
        const f=await server();vi.stubEnv('HTTP_PROXY',f.proxy);vi.stubEnv(key,'127.0.0.1');vi.stubEnv('NODE_USE_ENV_PROXY','1');const probe=await child(f.url);
        await expect(probe.run()).rejects.toThrow('Сборка не выполнена.');expect(f.state).toEqual({tunnels:0,proxied:0,direct:1,foreign:0,refuse:false});
    });
    it.each([{value:undefined},{value:'0'},{value:'true'},{value:' 1'}])('Does not enable native Node proxy behavior for opt-in $value',async({value})=>{
        const f=await server();vi.stubEnv('HTTP_PROXY',f.proxy);vi.stubEnv('NODE_USE_ENV_PROXY',value);const probe=await child(f.url);
        await expect(probe.run()).rejects.toThrow('Сборка не выполнена.');expect((await probe.env()).NODE_USE_ENV_PROXY).toBeUndefined();
        expect(f.state).toEqual({tunnels:0,proxied:0,direct:1,foreign:0,refuse:false});
    });
    it('A real refused proxy gives a safe failure and a new bounded attempt succeeds without leaking child diagnostics',async()=>{
        const f=await server();vi.stubEnv('HTTP_PROXY',f.proxy);vi.stubEnv('NODE_USE_ENV_PROXY','1');f.state.refuse=true;const failed=await child(f.url);
        const error=await failed.run().catch(cause=>cause as unknown);if(!(error instanceof Error))throw Error('Expected a rejected child');expect(error.message).toBe('Сборка не выполнена. Проверьте npm-пакет, файл запуска и его зависимости.');
        expect(error.message).not.toMatch(/PRIVATE|owned-secret|fixture\.invalid/);expect(f.state.tunnels).toBe(1);expect(f.state.proxied+f.state.direct).toBe(0);
        const retry=await child(f.url);await expect(retry.run()).resolves.toBe(path.join(retry.stage,'output/asset.json'));
        expect(f.state).toEqual({tunnels:2,proxied:1,direct:0,foreign:0,refuse:false});
    });
});
