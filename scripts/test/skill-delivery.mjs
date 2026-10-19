// Проверка границы «серверный пакет с зависимостями → реальные локальные файлы» без изменения каталога.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root=process.cwd();const require=createRequire(path.join(root,'services/catalog-service/package.json'));
const original=globalThis.fetch;
const {DeviceArtifacts}=require(path.join(root,'services/catalog-service/dist/devices/device-artifacts.js'));
const {verifyPackage}=require(path.join(root,'services/catalog-service/dist/catalog/bundle-package.js'));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-skill-delivery-'));
process.env.NEUROCENTER_URL='http://localhost:5173';process.env.NEUROCENTER_BRIDGE_HOME=path.join(temp,'bridge');
const {setRoot,bindProject}=await import(path.join(root,'mcp/neurocenter-asset-sync/dist/bridge/workspace.js'));
const {install}=await import(path.join(root,'mcp/neurocenter-asset-sync/dist/bridge/installer.js'));
try{
    globalThis.fetch=async()=>Response.json({meta:{slug:'skill-with-tools',description:'Инструкция с зависимостями',version:2,mcp:['existing-mcp'],plugins:['existing-plugin']},body:'Проверьте инструменты перед выполнением.'});
    const artifacts=new DeviceArtifacts({});const pkg=await artifacts.build('skill','common/fixture',2);
    assert(verifyPackage(pkg));assert.deepEqual(pkg.config.extra.requirements,{mcp:['existing-mcp'],plugins:['existing-plugin']});
    const folder=path.join(temp,'projects','локальная папка');await fs.mkdir(folder,{recursive:true});await setRoot(path.dirname(folder));await bindProject('prj-fixture','локальная папка');
    await install('prj-fixture',pkg,async()=>({ok:true}),async()=>undefined);
    const text=await fs.readFile(path.join(folder,'.opencode/skills/skill-with-tools/SKILL.md'),'utf8');assert(text.includes('mcp: ["existing-mcp"]'));assert(text.includes('plugins: ["existing-plugin"]'));
    await assert.rejects(()=>artifacts.build('skill','common/fixture',1),/изменился/);
    await fs.writeFile('.run/skill-delivery-smoke.json',JSON.stringify({passed:3,cases:['Скилл с зависимостями устанавливается без обещания их запуска','Требования сохранены в проверенном манифесте и SKILL.md','Несвежая версия скилла отклоняется']},null,2));
    console.log('Пакет скилла и локальные файлы: 3 проверки пройдены.');
}finally{globalThis.fetch=original;await fs.rm(temp,{recursive:true,force:true});}
