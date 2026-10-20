import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {verifyFile} from '../models/bundle-files.mjs';
import {formatAssetProgress,assetProgressReporter} from '../assets/progress.mjs';

test('SHA-проверка сообщает байты до завершения чтения файла',async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'nc-model-progress-'));
    try {
        const filename=path.join(directory,'weights'),bytes=Buffer.alloc(512*1024,17);
        await writeFile(filename,bytes);let read=0,finished=false;
        const progress=[];
        const verified=await verifyFile(filename,{size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},{onBytes:count=>{
            assert.equal(finished,false);read+=count;progress.push(read);
        }});
        finished=true;
        assert.equal(verified,true);assert.ok(progress.length>1);
        assert.ok(progress[0]>0&&progress[0]<bytes.length);assert.equal(read,bytes.length);
    } finally {await rm(directory,{recursive:true,force:true});}
});

test('Терминал показывает объём, процент и количество файлов без внутренних путей',()=>{
    assert.equal(formatAssetProgress({message:'Загрузка.',completed:1024**3,total:4*1024**3}),'Загрузка. 25% · 1.0 ГиБ / 4.0 ГиБ');
    assert.equal(formatAssetProgress({message:'Проверка.',completed:2,total:9,unit:'files'}),'Проверка. 2/9 файлов');
    assert.equal(formatAssetProgress({message:'Подготовка.',completed:0,total:0}),'Подготовка.');
    const value=formatAssetProgress({message:'Проверка.',completed:1024,total:2048,path:'/private/user-project/weights'});
    assert.equal(value,'Проверка. 50% · 1.0 КиБ / 2.0 КиБ');
});

test('Стадия видна сразу, счётчик обновляется раз в две секунды, готовность не теряется',()=>{
    let now=100;const lines=[];
    const report=assetProgressReporter(line=>lines.push(line),()=>now);
    report({stage:'verifying',message:'Проверка SHA.',completed:0,total:100});
    now=200;report({stage:'verifying',message:'Проверка SHA.',completed:10,total:100});
    assert.equal(lines.length,1);
    now=2100;report({stage:'verifying',message:'Проверка SHA.',completed:50,total:100});
    assert.match(lines.at(-1),/50%/);
    now=2200;report({stage:'assembling',message:'Сборка.',completed:0,total:100});
    assert.equal(lines.length,3);assert.match(lines.at(-1),/Сборка/);
    now=2300;report({stage:'verifying',message:'Проверка собранного файла.',completed:0,total:100});
    assert.equal(lines.length,4);
    report({stage:'ready',message:'Готово.',completed:100,total:100});
    assert.equal(lines.length,5);assert.match(lines.at(-1),/100%/);
});
