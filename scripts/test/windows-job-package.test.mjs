import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {packageWindowsJobHelper} from '../bridge-windows-job.mjs';

async function fixture(action){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-windows-helper-package-'));
    try{await fs.mkdir(path.join(root,'bin'));await action(root);}finally{await fs.rm(root,{recursive:true,force:true});}
}
function pe(machine=0x8664){const value=Buffer.alloc(512);value.write('MZ');value.writeUInt32LE(128,0x3c);value.writeUInt32LE(0x4550,128);value.writeUInt16LE(machine,132);return value;}
test('На macOS/Linux упаковщик не подменяет платформу синтетическим Windows helper',async()=>{
    assert.equal(await packageWindowsJobHelper({platform:'darwin',content:'/unused'}),undefined);
});
test('Windows-поставка без helper останавливается с действием для сборщика',async()=>{
    await assert.rejects(packageWindowsJobHelper({platform:'win32',arch:'x64',content:'/unused',args:[]}),/windows-job-helper/);
});
test('Синтетический PE правильной архитектуры закрепляется по SHA без изменения входного файла',async()=>fixture(async root=>{
    const source=path.join(root,'source.exe'),bytes=pe();await fs.writeFile(source,bytes);
    const descriptor=await packageWindowsJobHelper({platform:'win32',arch:'x64',content:root,args:['--windows-job-helper='+source]});
    assert.deepEqual(descriptor,{file:'bin/neurocenter-job.exe',sha256:createHash('sha256').update(bytes).digest('hex')});
    assert.deepEqual(await fs.readFile(source),bytes);assert.deepEqual(await fs.readFile(path.join(root,descriptor.file)),bytes);
}));
test('Чужая архитектура и повреждённый PE не публикуются в runtime',async()=>fixture(async root=>{
    const source=path.join(root,'source.exe');await fs.writeFile(source,pe(0xaa64));
    await assert.rejects(packageWindowsJobHelper({platform:'win32',arch:'x64',content:root,args:['--windows-job-helper='+source]}),/архитектуры/);
    const broken=pe();broken.writeUInt32LE(99999,0x3c);await fs.writeFile(source,broken);
    await assert.rejects(packageWindowsJobHelper({platform:'win32',arch:'x64',content:root,args:['--windows-job-helper='+source]}),/повреждён/);
    assert.deepEqual(await fs.readdir(path.join(root,'bin')),[]);
}));
test('Ссылка вместо helper не читается и не попадает в пакет',async()=>fixture(async root=>{
    const source=path.join(root,'source.exe'),link=path.join(root,'link.exe');await fs.writeFile(source,pe());await fs.symlink(source,link);
    await assert.rejects(packageWindowsJobHelper({platform:'win32',arch:'x64',content:root,args:['--windows-job-helper='+link]}),/Некорректный/);
    assert.deepEqual(await fs.readdir(path.join(root,'bin')),[]);
}));
