import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadJobRuntimeArtifact } from '../src/bridge/runtime-artifact-download.js';
import { hash, jobContext, writeState } from '../src/bridge/state.js';
import type { RuntimeArtifact } from '../src/features/runtime-artifacts/model.js';

const roots: string[] = [], servers: Array<http.Server | net.Server> = [];
const job = {id: randomUUID(), lease: randomUUID(), deviceId: randomUUID()};
const descriptor = (bytes: Buffer): RuntimeArtifact => ({target:'darwin-arm64',sha256:hash(bytes),compressedBytes:bytes.length,unpackedBytes:1,filesCount:1,entrypoint:'index.mjs'});
async function setup(server: http.Server | net.Server) {
    servers.push(server); await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
    const root = await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-http-artifact-')); roots.push(root);
    vi.stubEnv('NEUROCENTER_BRIDGE_HOME',root); vi.stubEnv('NEUROCENTER_URL',`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
    await writeState('credentials',{token:'private-fixture-token',deviceId:job.deviceId,email:'fixture@example.test'});
    vi.stubGlobal('fetch',vi.fn(() => {throw new Error('Global fetch запрещён для архива');}));
}
afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();for(const server of servers.splice(0)){if(server instanceof http.Server)server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});

describe('Скачивание готового комплекта через native HTTP',()=>{
    it('Настоящий FIN под backpressure не роняет процесс и сохраняет все байты и узкие заголовки',async()=>{
        const bytes=Buffer.alloc(512*1024,0x61), artifact=descriptor(bytes);let headers: http.IncomingHttpHeaders | undefined;
        await setup(net.createServer(socket=>socket.once('data',request=>{
            const text=request.toString();headers=Object.fromEntries(text.split('\r\n').slice(1).filter(Boolean).map(line=>{const split=line.indexOf(':');return[line.slice(0,split).toLowerCase(),line.slice(split+1).trim()];}));
            expect(text.split('\r\n')[0]).toBe(`GET /api/device-channel/jobs/${job.id}/runtime/${artifact.sha256} HTTP/1.1`);
            socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`),bytes]));
        })));
        const stream=await jobContext.run(job,()=>downloadJobRuntimeArtifact(artifact));
        await new Promise(resolve=>setTimeout(resolve,40)); // parser/socket завершаются до чтения тела
        const chunks:Buffer[]=[];
        await pipeline(stream,new Writable({highWaterMark:1,write(chunk:Buffer,_encoding,done){chunks.push(chunk);setTimeout(done,2);}}));
        expect(Buffer.concat(chunks)).toEqual(bytes);expect(headers?.authorization).toBe('Bearer private-fixture-token');
        expect(headers?.['x-neurocenter-job-id']).toBe(job.id);expect(headers?.['x-neurocenter-job-lease']).toBe(job.lease);
        expect(headers?.['accept-encoding']).toBe('identity');expect(fetch).not.toHaveBeenCalled();
    });
    it.each([302,401,500])('Не следует redirect и отклоняет HTTP %s до отдачи тела',async status=>{
        let requests=0;await setup(http.createServer((_req,res)=>{requests++;res.writeHead(status,{'content-length':'3',location:'/redirect-target'});res.end('bad');}));
        await expect(jobContext.run(job,()=>downloadJobRuntimeArtifact(descriptor(Buffer.from('abc'))))).rejects.toThrow(/недоступен/);expect(requests).toBe(1);
    });
    it('Отклоняет несовпадающий Content-Length',async()=>{
        await setup(http.createServer((_req,res)=>{res.writeHead(200,{'content-length':'4'});res.end('abcd');}));
        await expect(jobContext.run(job,()=>downloadJobRuntimeArtifact(descriptor(Buffer.from('abc'))))).rejects.toThrow(/размер/);
    });
    it('Оборванное тело даёт catchable stream error вместо успеха',async()=>{
        await setup(net.createServer(socket=>socket.once('data',()=>socket.end('HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nabc'))));
        const stream=await jobContext.run(job,()=>downloadJobRuntimeArtifact(descriptor(Buffer.alloc(8))));
        await expect(pipeline(stream,new Writable({write(_chunk,_encoding,done){done();}}))).rejects.toThrow();
    });
    it.each(['headers','body'])('Ограничивает время ожидания: %s',async phase=>{
        const sockets=new Set<net.Socket>();const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.once('data',()=>{if(phase==='body')socket.write('HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\na');});});
        await setup(server);
        try{await expect(jobContext.run(job,async()=>{const stream=await downloadJobRuntimeArtifact(descriptor(Buffer.alloc(8)),30);await pipeline(stream,new Writable({write(_chunk,_encoding,done){done();}}));})).rejects.toThrow();}
        finally{for(const socket of sockets)socket.destroy();}
    });
    it('Сетевая ошибка и чужой device не создают успешный stream',async()=>{
        const server=http.createServer();await setup(server);await new Promise<void>(resolve=>server.close(()=>resolve()));
        await expect(jobContext.run(job,()=>downloadJobRuntimeArtifact(descriptor(Buffer.from('abc'))))).rejects.toThrow(/загрузить/);
        await expect(jobContext.run({...job,deviceId:randomUUID()},()=>downloadJobRuntimeArtifact(descriptor(Buffer.from('abc'))))).rejects.toThrow(/подключения/);
    });
});
