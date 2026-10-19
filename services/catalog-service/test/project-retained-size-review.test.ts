import {createServer,type ServerResponse,type IncomingMessage} from 'node:http';
import {afterEach,describe,expect,it} from 'vitest';
import {fetchProjectRetainedSize} from '../src/catalog/project-retained-size';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});

async function fixture(handler:(request:IncomingMessage,response:ServerResponse)=>void){
    const server=createServer(handler);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    cleanups.push(()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();}));
    const address=server.address();if(!address||typeof address==='string')throw new Error('Не получен адрес fixture');
    return 'http://127.0.0.1:'+address.port;
}

describe('Независимый adversarial review измерения проектной копии',()=>{
    it('Общий deadline прерывает даже активный поток с поступающими байтами',async()=>{
        let socketClosed=false;
        const endpoint=await fixture((_request,response)=>{
            response.writeHead(200);response.write('{');
            const timer=setInterval(()=>response.write(' '),10);
            response.once('close',()=>{clearInterval(timer);socketClosed=true;});
        });
        const started=Date.now();
        const result=await fetchProjectRetainedSize(endpoint,'prj-own','test-secret',80);
        expect(result.bytes).toBeNull();expect(result.error).toContain('вовремя');
        expect(Date.now()-started).toBeLessThan(1500);
        await new Promise(resolve=>setTimeout(resolve,40));expect(socketClosed).toBe(true);
    });

    it('Слишком большой chunked-ответ закрывается до полного скачивания',async()=>{
        let socketClosed=false;
        const endpoint=await fixture((_request,response)=>{
            response.writeHead(200);response.write(' '.repeat(17*1024));
            response.once('close',()=>{socketClosed=true;});
        });
        const result=await fetchProjectRetainedSize(endpoint,'prj-own','test-secret',1000);
        expect(result.bytes).toBeNull();expect(result.error).toContain('некорректный');
        await new Promise(resolve=>setTimeout(resolve,40));expect(socketClosed).toBe(true);
    });

    it('Обрыв ответа после валидного начала не превращается в ноль и не висит',async()=>{
        const endpoint=await fixture((_request,response)=>{
            response.writeHead(200,{'content-length':1000});response.write('{"projectKey":"prj-own","bytes":0');
            setImmediate(()=>response.destroy());
        });
        const started=Date.now();
        const result=await fetchProjectRetainedSize(endpoint,'prj-own','test-secret',1000);
        expect(result.bytes).toBeNull();expect(result.error).toBeTruthy();expect(Date.now()-started).toBeLessThan(1000);
    });

    it.each([
        {projectKey:'prj-foreign',bytes:12},
        {projectKey:'prj-own',bytes:'12'},
        {projectKey:'prj-own',bytes:-1},
        {projectKey:'prj-own',bytes:Number.MAX_SAFE_INTEGER+1},
        {projectKey:'prj-own'},
    ])('Чужая область и неподтверждённые числа отклоняются: %j',async body=>{
        const endpoint=await fixture((_request,response)=>response.end(JSON.stringify(body)));
        const result=await fetchProjectRetainedSize(endpoint,'prj-own','test-secret',1000);
        expect(result.bytes).toBeNull();expect(result.error).toContain('некорректный');
    });

    it('Закрытый backend не раскрывает URL, внутренний токен или текст своего отказа',async()=>{
        const secret='internal-secret-never-visible';
        let header:string|undefined;
        const endpoint=await fixture((request,response)=>{
            header=request.headers['x-neurocenter-internal'] as string;
            response.writeHead(503);response.end('PRIVATE postgres password='+secret);
        });
        const result=await fetchProjectRetainedSize(endpoint,'prj-own',secret,1000);
        expect(header).toBe(secret);expect(result.bytes).toBeNull();
        expect(JSON.stringify(result)).not.toContain(secret);expect(JSON.stringify(result)).not.toContain(endpoint);
        expect(JSON.stringify(result)).not.toContain('PRIVATE');
    });

    it('Ключ проекта кодируется отдельным query-параметром и нулевой замер сохраняется',async()=>{
        const key='prj-own &projectKey=prj-foreign/日本語';
        let actualUrl:URL|undefined;
        const endpoint=await fixture((request,response)=>{
            actualUrl=new URL(request.url!,'http://fixture.test');
            response.end(JSON.stringify({projectKey:key,bytes:0}));
        });
        expect(await fetchProjectRetainedSize(endpoint+'/prefix?old=removed#hash',key,'',1000)).toEqual({bytes:0});
        expect(actualUrl!.pathname).toBe('/prefix/api/rag/size');
        expect(actualUrl!.searchParams.getAll('projectKey')).toEqual([key]);
        expect(actualUrl!.searchParams.has('old')).toBe(false);
    });
});
