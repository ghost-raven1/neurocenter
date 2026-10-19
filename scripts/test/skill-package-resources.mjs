import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Настоящий HTTP-сервис и собранный worker используют только временные каталоги.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root,'services/catalog-service/package.json'));
const { DeviceArtifacts } = require(path.join(root,'services/catalog-service/dist/devices/device-artifacts.js'));
const { verifyPackage } = require(path.join(root,'services/catalog-service/dist/catalog/bundle-package.js'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'nc-full-skill-'));
const socket = net.createServer(); await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
const port = socket.address().port; await new Promise(resolve=>socket.close(resolve));
const token = randomBytes(32).toString('hex');
const metricsToken = randomBytes(32).toString('hex');
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath,[path.join(root,'services/skills-service/dist/main.js')],{cwd:root,
    env:{...process.env,NODE_ENV:'production',NEUROCENTER_SERVICE:'skills-service',PANEL_URL:'https://fixture.example.test',
        NEUROCENTER_INTERNAL_TOKEN:token,NEUROCENTER_METRICS_TOKEN:metricsToken,PORT:String(port),BIND_HOST:'127.0.0.1',SKILLS_STORAGE_PATH:path.join(temporary,'skills')},stdio:['ignore','pipe','pipe']});
let logs=''; child.stdout.on('data',chunk=>{logs+=chunk;}); child.stderr.on('data',chunk=>{logs+=chunk;});
process.env.SKILLS_SERVICE_URL=base;process.env.NEUROCENTER_INTERNAL_TOKEN=token;
process.env.NEUROCENTER_BRIDGE_HOME=path.join(temporary,'private');process.env.NEUROCENTER_URL='http://localhost:5173';
const {setRoot,bindProject}=await import(path.join(root,'mcp/neurocenter-asset-sync/dist/bridge/workspace.js'));
const {install}=await import(path.join(root,'mcp/neurocenter-asset-sync/dist/bridge/installer.js'));
const {uninstall}=await import(path.join(root,'mcp/neurocenter-asset-sync/dist/bridge/uninstaller.js'));
const cases=[];
const check=async(name,action)=>{await action();cases.push(name);console.log('OK '+name);};
const request=async(method,route,body)=>{
    const response=await fetch(base+'/api/skills'+route,{method,headers:{'content-type':'application/json','x-neurocenter-internal':token,'x-bridge-user-id':'fixture-author'},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();return {status:response.status,data};
};
try {
    const deadline=Date.now()+15000;
    while(true){try{if((await fetch(base+'/ready')).ok)break;}catch{}if(child.exitCode!==null||Date.now()>deadline)throw new Error('Сервис не запустился: '+logs);await new Promise(resolve=>setTimeout(resolve,100));}
    const resource={path:'assets/пример.bin',content:Buffer.from([0,255,128,13,10]).toString('base64'),encoding:'base64'};
    await check('Публикация сохраняет инструкцию, скрипт и бинарный ресурс одной версией',async()=>{
        const response=await request('POST','',{path:'common',slug:'full-skill',name:'Полный скилл',body:'Первая инструкция',meta:{description:'С ресурсами'},resources:[resource,{path:'assets/z.txt',content:'latin'},{path:'scripts/check.mjs',content:'export const ok=true;'}]});
        assert.equal(response.status,201);assert.equal(response.data.resources.length,3);
    });
    await check('После обновления HTTP выдаёт исходную инструкцию и ресурсы по номеру версии',async()=>{
        assert.equal((await request('PUT','/common/full-skill',{expectedVersion:1,body:'Вторая инструкция',resources:[]})).status,200);
        const previous=await request('GET','/common/full-skill?version=1');assert.equal(previous.status,200);assert.equal(previous.data.body,'Первая инструкция');assert.equal(previous.data.resources.length,3);
        const missing=await request('GET','/common/full-skill?version=99');assert.equal(missing.status,404);
    });
    let pkg;
    await check('Каталог собирает проверяемый пакет конкретной старой версии через HTTP',async()=>{
        pkg=await new DeviceArtifacts({}).build('skill','common/full-skill',1);assert.equal(pkg.schemaVersion,4);assert.equal(pkg.files.length,4);assert.equal(verifyPackage(pkg),true);
        const source="import {verify} from "+JSON.stringify(pathToFileURL(path.join(root,'mcp/neurocenter-asset-sync/dist/bridge/package.js')).href)+";let text='';for await(const chunk of process.stdin)text+=chunk;verify(JSON.parse(text));console.log(Intl.Collator().resolvedOptions().locale);";
        for (const [environment,expected] of [['ru_RU.UTF-8','ru-RU'],['tr_TR.UTF-8','tr-TR']]) {
            const locale=execFileSync(process.execPath,['--input-type=module','-e',source],{input:JSON.stringify(pkg),encoding:'utf8',env:{...process.env,LANG:environment,LC_ALL:environment}}).trim();
            assert.equal(locale,expected);
        }
    });
    const project=path.join(temporary,'projects','Папка с пробелами');await fs.mkdir(project,{recursive:true});await setRoot(path.dirname(project));await bindProject('fixture',path.basename(project));
    await check('Собранный MCP устанавливает ресурсы в выбранную папку и сохраняет байты',async()=>{
        await install('fixture',pkg,async()=>{},async()=>{});
        const skill=path.join(project,'.opencode/skills/full-skill');assert.deepEqual(await fs.readFile(path.join(skill,'assets/пример.bin')),Buffer.from(resource.content,'base64'));
        assert.equal(await fs.readFile(path.join(skill,'scripts/check.mjs'),'utf8'),'export const ok=true;');
    });
    await check('Повтор установки и удаление сверяют полный состав пакета',async()=>{
        await install('fixture',pkg,async()=>{},async()=>{});const result=await uninstall('fixture',pkg,async()=>{},async()=>{});assert.equal(result.files,4);
    });
    await check('Ошибочные версии, обход путей и неавторизованный запрос отвергаются',async()=>{
        assert.equal((await request('GET','/common/full-skill?version=NaN')).status,400);
        assert.equal((await request('PUT','/common/full-skill',{expectedVersion:2,resources:[{path:'assets/../outside',content:'x'}]})).status,400);
        assert.equal((await fetch(base+'/api/skills/common/full-skill')).status,403);
        assert.equal((await request('GET','/common/full-skill')).data.meta.version,2);
    });
    await check('Настоящий сервис выдаёт метрики только отдельному сборщику без путей скиллов',async()=>{
        assert.equal((await fetch(base+'/metrics',{headers:{Authorization:'Bearer '+token}})).status,403);
        const response=await fetch(base+'/metrics',{headers:{Authorization:'Bearer '+metricsToken}});assert.equal(response.status,200);
        const text=await response.text();assert.ok(text.includes('neurocenter_http_requests_total'));assert.equal(text.includes('full-skill'),false);
    });
    const destination=process.env.SKILL_RESOURCES_REPORT||path.join(root,'.run/pilot-implementation-20261017/skill-resources.json');
    await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,JSON.stringify({passed:cases.length,cases},null,2)+'\n');
} finally {
    child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null){resolve();return;}child.once('exit',resolve);});
    await fs.rm(temporary,{recursive:true,force:true});
}
