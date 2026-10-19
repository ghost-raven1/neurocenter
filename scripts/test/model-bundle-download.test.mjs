import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {downloadPart} from '../models/bundle-files.mjs';

const bytes=Buffer.from('public model fixture');
const part={size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
const url='https://github.com/ghost-raven1/neurocenter/releases/download/models-fixture.1/part.bin';

async function fixture(action) {
    const root=await mkdtemp(path.join(tmpdir(),'nc-model-download-'));
    let cancelled=0;
    const response=new Response(new ReadableStream({
        start(controller){controller.enqueue(bytes);},
        cancel(){cancelled++;},
    }),{headers:{'content-length':String(bytes.length)}});
    try {await action({root,response,cancelled:()=>cancelled});}
    finally {await response.body.cancel().catch(()=>{});await rm(root,{recursive:true,force:true});}
}

test('Отказ записи существующего файла закрывает HTTP-поток и сохраняет файл',async()=>fixture(async({root,response,cancelled})=>{
    const target=path.join(root,'existing');await writeFile(target,'USER DATA');
    await assert.rejects(downloadPart(url,target,part,{fetch:async()=>response}),{code:'EEXIST'});
    assert.equal(cancelled(),1);assert.equal(response.body.locked,false);
    assert.equal(await readFile(target,'utf8'),'USER DATA');
}));

test('Отсутствующий каталог загрузки также освобождает уже полученный HTTP-ответ',async()=>fixture(async({root,response,cancelled})=>{
    await assert.rejects(downloadPart(url,path.join(root,'missing','part'),part,{fetch:async()=>response}),{code:'ENOENT'});
    assert.equal(cancelled(),1);assert.equal(response.body.locked,false);
}));

test('Неверный размер HTTP-ответа закрывает поток до создания файла',async()=>fixture(async({root,response,cancelled})=>{
    response.headers.set('content-length','1');const target=path.join(root,'part');
    await assert.rejects(downloadPart(url,target,part,{fetch:async()=>response}),/Размер ответа/);
    assert.equal(cancelled(),1);await assert.rejects(access(target),{code:'ENOENT'});
}));

test('Успешная загрузка сохраняет проверенные байты и освобождает reader',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'nc-model-download-'));
    try {
        const target=path.join(root,'part'),response=new Response(bytes);let written=0;
        await downloadPart(url,target,part,{fetch:async()=>response,onBytes:count=>{written+=count;}});
        assert.deepEqual(await readFile(target),bytes);assert.equal(written,bytes.length);assert.equal(response.body.locked,false);
    }finally{await rm(root,{recursive:true,force:true});}
});

test('Отказ записи прерывает настоящий HTTP-ответ, не дожидаясь завершения передачи',{timeout:5000},async t=>{
    const root=await mkdtemp(path.join(tmpdir(),'nc-model-download-http-'));
    let finish;const closed=new Promise(resolve=>{finish=resolve;});
    const server=createServer((_request,response)=>{
        response.writeHead(200,{'Content-Length':1024**2});
        response.write(Buffer.alloc(1024));
        const interval=setInterval(()=>response.write(Buffer.alloc(1024)),20);
        response.once('close',()=>{clearInterval(interval);finish();});
    });
    t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const target=path.join(root,'existing');await writeFile(target,'USER DATA');
    await assert.rejects(downloadPart(url,target,{...part,size:1024**2},{fetch:()=>fetch(`http://127.0.0.1:${server.address().port}`)}),{code:'EEXIST'});
    let timeout;
    try {
        await Promise.race([closed,new Promise((_resolve,reject)=>{timeout=setTimeout(()=>reject(new Error('HTTP-передача осталась открыта после отказа записи')),1000);})]);
    }finally{clearTimeout(timeout);}
    assert.equal(await readFile(target,'utf8'),'USER DATA');
});
