import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {fetchNpmMetadata} from '../src/package-build/npm-source-transport';

describe('Dependency metadata has a request-scoped TLS exception',()=>{
    let root:string,server:https.Server,url:string;const sockets=new Set<net.Socket>();const paths:string[]=[];
    const track=(socket:net.Socket)=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));};
    beforeAll(async()=>{
        root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-npm-metadata-tls-'));
        const key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');
        const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,'-subj','/CN=localhost'],{encoding:'utf8',timeout:15000});
        expect(generated.status,generated.stderr).toBe(0);
        server=https.createServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},(request,response)=>{
            paths.push(request.url!);
            if(request.url==='/redirect'){response.writeHead(302,{location:url+'/followed'}).end();return;}
            if(request.url==='/waiting')return;
            if(request.url==='/empty'){response.writeHead(204).end();return;}
            if(request.url==='/invalid-status'){response.writeHead(600).end();return;}
            response.writeHead(200,{'content-type':'application/json'}).end('{"name":"owned-tool","version":"1.0.0"}');
        });
        server.on('connection',track);
        await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
        url='https://127.0.0.1:'+(server.address() as net.AddressInfo).port;
    });
    beforeEach(()=>{paths.length=0;vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED','1');vi.stubEnv('NODE_USE_ENV_PROXY',undefined);});
    afterEach(()=>vi.unstubAllEnvs());
    afterAll(async()=>{for(const socket of sockets)socket.destroy();if(server?.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));if(root)await fs.rm(root,{recursive:true,force:true});});
    const fetch=(route='')=>fetchNpmMetadata(url+route,{redirect:'error',signal:AbortSignal.timeout(2000)});
    const strict=()=>new Promise((resolve,reject)=>{const agent=new https.Agent({rejectUnauthorized:true});const request=https.get(url,{agent},response=>{response.resume();resolve(response.statusCode);});request.once('error',reject);request.once('close',()=>agent.destroy());});

    it('A strict request rejects the same certificate before and after a successful metadata request',async()=>{
        await expect(strict()).rejects.toMatchObject({code:'DEPTH_ZERO_SELF_SIGNED_CERT'});
        const globalOptions={...https.globalAgent.options};
        await expect((await fetch()).json()).resolves.toEqual({name:'owned-tool',version:'1.0.0'});
        expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('1');expect(https.globalAgent.options).toEqual(globalOptions);
        await expect(strict()).rejects.toMatchObject({code:'DEPTH_ZERO_SELF_SIGNED_CERT'});expect(paths).toEqual(['/']);
    });
    it('Redirects never reach their destination',async()=>{
        await expect(fetch('/redirect')).rejects.toThrow('redirect');expect(paths).toEqual(['/redirect']);
    });
    it('An empty HTTP response remains an empty response for the existing metadata validation',async()=>{
        const response=await fetch('/empty');expect(response.status).toBe(204);expect(response.body).toBeNull();
    });
    it('A status unsupported by the web response is a rejected request rather than an uncaught server callback',async()=>{
        await expect(fetch('/invalid-status')).rejects.toBeInstanceOf(RangeError);
    });
    it('The original abort signal bounds a request that never sends headers',async()=>{
        await expect(fetchNpmMetadata(url+'/waiting',{redirect:'error',signal:AbortSignal.timeout(50)})).rejects.toMatchObject({name:'AbortError'});
    });
    it('The configured Node proxy route is kept for self-signed dependency HTTPS',async()=>{
        let tunnels=0;const port=new URL(url).port,proxy=http.createServer();proxy.on('connection',track);
        proxy.on('connect',(request,socket,head)=>{
            if(request.url!=='127.0.0.1:'+port){socket.destroy();return;}tunnels++;
            const target=net.connect(Number(port),'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)target.write(head);socket.pipe(target);target.pipe(socket);});
            track(target);target.on('error',()=>socket.destroy());socket.on('error',()=>target.destroy());socket.once('close',()=>target.destroy());
        });
        await new Promise<void>((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',()=>{proxy.off('error',reject);resolve();});});
        try{
            for(const key of ['http_proxy','HTTP_PROXY','https_proxy','HTTPS_PROXY','no_proxy','NO_PROXY'])vi.stubEnv(key,undefined);
            vi.stubEnv('HTTPS_PROXY','http://127.0.0.1:'+(proxy.address() as net.AddressInfo).port);vi.stubEnv('NODE_USE_ENV_PROXY','1');
            await expect((await fetch()).json()).resolves.toMatchObject({name:'owned-tool'});expect(tunnels).toBe(1);expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('1');
        }finally{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>proxy.close(()=>resolve()));}
    });
});
