import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createServer,type Server} from 'node:http';
import {ProjectRagClient} from '../src/models/project-rag-client';

/** Loopback transport: no active service, credentials or external inference. */
describe('RAG internal HTTP transport',()=>{
    let server:Server,url:string;const previous={url:process.env.RAG_SERVICE_URL,token:process.env.NEUROCENTER_INTERNAL_TOKEN};
    beforeAll(async()=>{
        server=createServer(async(req,res)=>{
            if(req.headers['x-neurocenter-internal']!=='fixture-internal-token'){res.writeHead(403);res.end('{}');return;}
            const path=req.url!.split('/').at(-1);res.setHeader('content-type','application/json');
            if(path==='bad-json'){res.end('not json');return;}
            if(path==='oversize'){for(let i=0;i<10;i++)res.write('x'.repeat(1024**2));res.end();return;}
            if(path==='conflict'){res.writeHead(409);res.end(JSON.stringify({message:'fixture CAS'}));return;}
            if(path==='failure'){res.writeHead(500);res.end(JSON.stringify({message:'fixture unavailable'}));return;}
            let body='';for await(const chunk of req)body+=chunk;res.end(JSON.stringify({method:req.method,body:body?JSON.parse(body):null}));
        });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
        url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;process.env.RAG_SERVICE_URL=url;process.env.NEUROCENTER_INTERNAL_TOKEN='fixture-internal-token';
    });
    afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));if(previous.url===undefined)delete process.env.RAG_SERVICE_URL;else process.env.RAG_SERVICE_URL=previous.url;if(previous.token===undefined)delete process.env.NEUROCENTER_INTERNAL_TOKEN;else process.env.NEUROCENTER_INTERNAL_TOKEN=previous.token;});
    it('GET и POST используют один internal endpoint и сохраняют JSON',async()=>{
        const client=new ProjectRagClient();expect(await client.call('fixture')).toEqual({method:'GET',body:null});expect(await client.call('fixture',{generation:'fixture',text:'日本語'})).toEqual({method:'POST',body:{generation:'fixture',text:'日本語'}});
    });
    it.each([['conflict',409],['failure',503],['bad-json',503],['oversize',503]] as const)('%s остаётся явной ошибкой %i',async(path,status)=>{await expect(new ProjectRagClient().call(path)).rejects.toMatchObject({status});});
    it('Прерванный запрос не выдаёт неподтверждённую запись за успешную',async()=>{const controller=new AbortController();controller.abort();await expect(new ProjectRagClient().call('fixture',{},controller.signal)).rejects.toMatchObject({status:503});});
});
