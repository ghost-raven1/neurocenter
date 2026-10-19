import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverRuntimePreparations, runtimePreparationCompletion, withRuntimePreparationIntent } from '../src/bridge/runtime-preparation-intent.js';
import { deliverCompletions, pendingCompletions, saveCompletion } from '../src/bridge/completions.js';
import { jobContext, stateDir, writeState } from '../src/bridge/state.js';
import { packageFixture } from './bridge-fixture.js';
import { artifactFixture } from '../../../scripts/test/runtime-artifact-fixture.cjs';
import { runtimeArtifactTarget } from '../src/features/runtime-artifacts/model.js';
import { resolvePreparedRuntimeArtifact } from '../src/features/runtime-artifacts/cache.js';
import { prepareJobRuntimeArtifacts } from '../src/bridge/job-runtime-artifacts.js';

const roots:string[]=[];
async function fixture(origin='http://127.0.0.1:5173'){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-preparation-intent-'));roots.push(root);
    vi.stubEnv('NEUROCENTER_BRIDGE_HOME',root);vi.stubEnv('NEUROCENTER_URL',origin);
    const deviceId=randomUUID();await writeState('credentials',{deviceId,token:'fixture-token',email:'fixture@example.test'});
    const job={id:randomUUID(),lease:randomUUID(),kind:'install',project_id:'qa-project',payload:{package:packageFixture('mcp'),bindingId:'a'.repeat(64)}};
    const completion=runtimePreparationCompletion(job,deviceId);
    return{root,deviceId,job,completion,file:path.join(stateDir(),'runtime-preparations',job.id+'.json')};
}
afterEach(async()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});

describe('Устойчивое подтверждение подготовки до записи проекта',()=>{
    it('Фиксирует 0600 intent до подготовки и очищает перед передачей в installer',async()=>{
        const f=await fixture();await withRuntimePreparationIntent(f.completion,async()=>{
            expect(JSON.parse(await fs.readFile(f.file,'utf8')).completion).toEqual(f.completion);
            if(process.platform!=='win32')expect((await fs.stat(f.file)).mode&0o777).toBe(0o600);
        });await expect(fs.access(f.file)).rejects.toMatchObject({code:'ENOENT'});expect(await pendingCompletions()).toEqual([]);
    });
    it('Catchable ошибка сохраняет failure до удаления intent, без повторной загрузки',async()=>{
        const f=await fixture();let calls=0;
        await expect(withRuntimePreparationIntent(f.completion,async()=>{calls++;throw new Error('Обрыв сети');})).rejects.toThrow('Обрыв сети');
        expect(calls).toBe(1);expect(await pendingCompletions()).toEqual([f.completion]);await expect(fs.access(f.file)).rejects.toMatchObject({code:'ENOENT'});
    });
    it('До настоящего HTTP GET уже существует intent; cache проверяет SHA до успешной передачи installer',async()=>{
        const {archive,descriptor}=artifactFixture(undefined,runtimeArtifactTarget());let seen=false;let file='';
        const server=http.createServer((_req,res)=>{void fs.readFile(file,'utf8').then(()=>{seen=true;res.writeHead(200,{'content-length':String(archive.length)});res.end(archive);},()=>{res.writeHead(500);res.end();});});
        await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
        try{
            const f=await fixture(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);file=f.file;
            const pkg={...f.job.payload.package!,config:{extra:{runtimeArtifacts:[descriptor]}}};
            await jobContext.run({id:f.job.id,lease:f.job.lease,deviceId:f.deviceId},()=>prepareJobRuntimeArtifacts([pkg],async()=>{},async()=>{},{intent:f.completion}));
            expect(seen).toBe(true);expect((await resolvePreparedRuntimeArtifact(pkg))?.sha256).toBe(descriptor.sha256);
            await expect(fs.access(file)).rejects.toMatchObject({code:'ENOENT'});expect(await pendingCompletions()).toEqual([]);
        }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
    });
    it.each([false,true])('После SIGKILL новый worker доставляет подтверждённый результат без повтора на 5%% (квитанция: %s)',async saved=>{
        const f=await fixture();const module=pathToFileURL(fileURLToPath(new URL('../src/bridge/runtime-preparation-intent.ts',import.meta.url))).href;
        const script=path.join(f.root,'crash.mjs');await fs.writeFile(script,`import{withRuntimePreparationIntent}from${JSON.stringify(module)};await withRuntimePreparationIntent(${JSON.stringify(f.completion)},async()=>{process.send('ready-at-5');setInterval(()=>{},1000);await new Promise(()=>{});});`);
        const tsx=fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url));
        const child=spawn(process.execPath,['--import',pathToFileURL(tsx).href,script],{env:process.env,stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr!.on('data',chunk=>stderr+=chunk);
        await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('exit',code=>reject(new Error('Подготовка не началась: '+code+' '+stderr)));});
        const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await ended;
        const expected=saved?{...f.completion,state:'succeeded' as const,result:{...f.completion.result,unchanged:false}}:f.completion;
        if(saved)await saveCompletion(expected);
        await recoverRuntimePreparations();const pending=await pendingCompletions();expect(pending).toEqual([expected]);
        const sent:unknown[]=[];await deliverCompletions(async item=>{sent.push(item);});expect(sent).toEqual([expected]);
        await recoverRuntimePreparations();expect(await pendingCompletions()).toEqual([]);await expect(fs.access(f.file)).rejects.toMatchObject({code:'ENOENT'});
    },15000);
    it('Не завершает живую подготовку или задание другого device',async()=>{
        const f=await fixture();await withRuntimePreparationIntent(f.completion,async()=>{await recoverRuntimePreparations();expect(await pendingCompletions()).toEqual([]);
            await writeState('credentials',{deviceId:randomUUID(),token:'other-token',email:'other@example.test'});await recoverRuntimePreparations();expect(await pendingCompletions()).toEqual([]);expect(await fs.stat(f.file)).toBeDefined();});
    });
    it('Сохраняет восстановленную файловую квитанцию и отклоняет повреждённую аренду',async()=>{
        const f=await fixture();const previous={...f.completion,state:'succeeded' as const,result:{...f.completion.result,unchanged:false}};
        await withRuntimePreparationIntent(f.completion,async()=>{await saveCompletion(previous);});
        expect(await pendingCompletions()).toEqual([previous]);
        await expect(withRuntimePreparationIntent({...f.completion,lease:'bad'},async()=>{})).rejects.toThrow(/Повреждено/);
    });
    it('Repair failure сохраняет changePlan и digest для серверной сверки',async()=>{
        const f=await fixture(),plan=randomUUID();const completion=runtimePreparationCompletion({...f.job,kind:'apply-local-change',payload:{...f.job.payload,changePlanId:plan,expectedChangeDigest:'b'.repeat(64)}},f.deviceId);
        expect(completion.result).toMatchObject({unchanged:true,changePlanId:plan,digest:'b'.repeat(64)});
        expect(()=>runtimePreparationCompletion({...f.job,kind:'apply-local-change'},f.deviceId)).toThrow();
    });
    it('Повреждённый lease в marker и ссылка вместо каталога не создают completion',async()=>{
        const f=await fixture(),folder=path.dirname(f.file);await fs.mkdir(folder,{recursive:true});
        await fs.writeFile(f.file,JSON.stringify({schemaVersion:1,pid:process.pid,completion:{...f.completion,lease:'bad'}}),{mode:0o600});
        await expect(recoverRuntimePreparations()).rejects.toThrow(/Повреждено/);expect(await pendingCompletions()).toEqual([]);
        await fs.rm(folder,{recursive:true});const outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.symlink(outside,folder,'dir');
        await expect(recoverRuntimePreparations()).rejects.toThrow(/недоступен/);expect(await fs.readdir(outside)).toEqual([]);
    });
});
