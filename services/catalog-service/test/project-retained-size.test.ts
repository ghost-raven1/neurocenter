import {afterEach,describe,it,expect} from 'vitest';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {fetchProjectRetainedSize} from '../src/catalog/project-retained-size';

let server:http.Server|undefined;
afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}});
async function rag(handler:http.RequestListener):Promise<string>{server=http.createServer(handler);await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+(server.address() as AddressInfo).port;}

describe('Транспорт измерения копии знаний',()=>{
    it('Кодирует ключ проекта, передаёт внутренний токен и сохраняет префикс URL',async()=>{
        let received:{url?:string;token?:string|string[]}={};
        const base=await rag((req,res)=>{received={url:req.url,token:req.headers['x-neurocenter-internal']};res.end(JSON.stringify({projectKey:'свой /?&',bytes:9}));});
        expect(await fetchProjectRetainedSize(base+'/prefix/','свой /?&','own-token')).toEqual({bytes:9});
        const url=new URL(received.url!,base);expect(url.pathname).toBe('/prefix/api/rag/size');
        expect(url.searchParams.get('projectKey')).toBe('свой /?&');expect(received.token).toBe('own-token');
    });
    it('Поток больше 16 КиБ отклоняется до окончания ответа',async()=>{
        const base=await rag((_req,res)=>res.write('x'.repeat(16385)));
        const result=await fetchProjectRetainedSize(base,'own','',500);
        expect(result.bytes).toBeNull();expect(result.error).toContain('некорректный');
    });
    it('Общий дедлайн останавливает медленный поток даже при регулярных чанках',async()=>{
        let closed=false;
        const base=await rag((_req,res)=>{
            res.write('{');const drip=setInterval(()=>res.write(' '),10);
            res.on('close',()=>{clearInterval(drip);closed=true;});
        });
        const started=Date.now(),result=await fetchProjectRetainedSize(base,'own','',70);
        expect(result.bytes).toBeNull();expect(result.error).toContain('вовремя');expect(Date.now()-started).toBeLessThan(1000);
        await new Promise(resolve=>setTimeout(resolve,20));expect(closed).toBe(true);
    });
    it('Оборванный ответ не зависает и повторный запрос возвращает подтверждённый ноль',async()=>{
        let fail=true;
        const base=await rag((_req,res)=>{
            if(fail){res.writeHead(200,{'Content-Length':'100'});res.write('{');setImmediate(()=>res.destroy());}
            else res.end(JSON.stringify({projectKey:'own',bytes:0}));
        });
        expect((await fetchProjectRetainedSize(base,'own','',500)).bytes).toBeNull();
        fail=false;expect(await fetchProjectRetainedSize(base,'own')).toEqual({bytes:0});
    });
    it.each(['garbage','file:///secret','ftp://user:secret@localhost'])('Некорректный адрес %s возвращает безопасную причину',async base=>{
        const result=await fetchProjectRetainedSize(base,'own','secret');expect(result.bytes).toBeNull();
        expect(result.error).not.toContain('secret');expect(result.error).not.toContain(base);
    });
});
