import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const source = fileURLToPath(new URL('../', import.meta.url));
const script = `import fs from 'node:fs/promises';
import path from 'node:path';
const base=process.env.AUDIT_SOURCE,temporary=process.env.AUDIT_TEMP;
process.env.NEUROCENTER_BRIDGE_HOME=path.join(temporary,'private');process.env.NEUROCENTER_URL='http://example.test';
const {setRoot,bindProject}=await import(base+'/src/bridge/workspace.ts');
const {writeState,jobContext,stateDir}=await import(base+'/src/bridge/state.ts');
const {readyIndex,row,metadata}=await import(base+'/test/rag-index-fixture.ts');
const {writeRows,enumerateIds}=await import(base+'/src/lib/lancedb.ts');
const {restoreRagDb}=await import(base+'/src/tools/restore-rag-db.ts');
const {locateStore}=await import(base+'/src/lib/store.ts');
const {pendingCompletions}=await import(base+'/src/bridge/completions.ts');
const root=path.join(temporary,'projects','fixture'),store=path.join(root,'.opencode/rag_db');
if(process.env.AUDIT_PHASE==='crash'){
 await fs.mkdir(root,{recursive:true});await setRoot(path.dirname(root));await bindProject('test-project',path.basename(root));
 await writeState('credentials',{token:'fixture',deviceId:'11111111-1111-4111-8111-111111111111',email:'owner@example.test'});
 await readyIndex(root);await writeRows(store,[row('local-original')],false,3);
 await fs.writeFile(path.join(store,'runtime-overrides.json'),JSON.stringify({retrieval:{topK:17}}));
 globalThis.fetch=async()=>Response.json({...metadata([row('server-row')]),chunks:[row('server-row')],hasMore:false});
 const rename=fs.rename.bind(fs),remove=fs.rm.bind(fs),point=process.env.AUDIT_POINT;
 fs.rename=async(from,to)=>{
  if(point==='before-first'&&from===store)process.kill(process.pid,'SIGKILL');
  await rename(from,to);
  if(point==='after-first'&&from===store&&String(to).endsWith('-previous'))process.kill(process.pid,'SIGKILL');
  if(point==='after-second'&&String(from).includes('.neurocenter-rag-restore-')&&!String(from).endsWith('-previous')&&to===store)process.kill(process.pid,'SIGKILL');
 };
 fs.rm=async(file,options)=>{
  if(String(file).endsWith('-previous')){
   if(point==='before-cleanup')process.kill(process.pid,'SIGKILL');
   if(point==='partial-cleanup'){await fs.unlink(path.join(file,'manifest.json'));process.kill(process.pid,'SIGKILL');}
   if(point==='after-cleanup'){await remove(file,options);process.kill(process.pid,'SIGKILL');}
  }
  return remove(file,options);
 };
 await jobContext.run({id:'22222222-2222-4222-8222-222222222222',lease:'33333333-3333-4333-8333-333333333333',deviceId:'11111111-1111-4111-8111-111111111111'},()=>restoreRagDb({projectKey:'test-project',project:root},root));
}else{
 let error;globalThis.fetch=()=>{throw new Error('Recovery не должен обращаться к сети');};
 try{await locateStore(root,root,true);await locateStore(root,root,true);}catch(failure){error=failure.message;}
 const ids=[];if(!error)for await(const id of enumerateIds(store))ids.push(id);
 const entries=await fs.readdir(path.dirname(store));
 const journals=await fs.readdir(path.join(stateDir(),'rag-restores')).catch(()=>[]);
 console.log(JSON.stringify({error,ids,settings:await fs.readFile(path.join(store,'runtime-overrides.json'),'utf8').catch(()=>null),leftovers:entries.filter(name=>name.startsWith('.neurocenter-rag-restore-')),journals:journals.filter(name=>name.endsWith('.json')),completions:await pendingCompletions()}));
}`;

describe.skipIf(process.platform === 'win32')('Прерванное восстановление RAG завершается без новой передачи', () => {
    let temporary: string;
    afterEach(async () => { if (temporary) { await fs.rm(temporary, { recursive: true, force: true }); } });

    async function run(phase: string, point = '') {
        if (!temporary) {
            temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nc-rag-recovery-')));
            await fs.writeFile(path.join(temporary, 'child.mjs'), script);
        }
        return new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
            const child = spawn(process.execPath, ['--import', path.join(source, 'node_modules/tsx/dist/loader.mjs'), path.join(temporary, 'child.mjs')], {
                cwd: source, env: { ...process.env, AUDIT_SOURCE: source, AUDIT_TEMP: temporary, AUDIT_PHASE: phase, AUDIT_POINT: point },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let output = '', errors = '';
            child.stdout.on('data', chunk => { output += chunk; });
            child.stderr.on('data', chunk => { errors += chunk; });
            child.once('error', reject);
            child.once('close', (code, signal) => code && !signal ? reject(new Error(errors)) : resolve({ code, signal, output }));
        });
    }

    async function journal() {
        const [hub] = await fs.readdir(path.join(temporary, 'private'));
        const directory = path.join(temporary, 'private', hub!, 'rag-restores');
        const [name] = (await fs.readdir(directory)).filter(name => name.endsWith('.json'));
        const file = path.join(directory, name!);
        return { file, value: JSON.parse(await fs.readFile(file, 'utf8')) as { root: string; store: string; stage: string; backup: string; pid: number } };
    }

    it.each(['before-first', 'after-first', 'after-second', 'before-cleanup', 'partial-cleanup', 'after-cleanup'])(
        'SIGKILL в точке %s сохраняет согласованный индекс, настройки и результат прежнего задания', async point => {
            temporary = '';
            expect((await run('crash', point)).signal).toBe('SIGKILL');
            const result = JSON.parse((await run('read')).output);
            const committed = point.includes('cleanup');
            expect(result.error).toBeUndefined();
            expect(result.ids).toEqual([committed ? 'server-row' : 'local-original']);
            expect(JSON.parse(result.settings)).toEqual({ retrieval: { topK: 17 } });
            expect(result.leftovers).toEqual([]); expect(result.journals).toEqual([]);
            expect(result.completions).toHaveLength(1);
            expect(result.completions[0]).toMatchObject({ id: '22222222-2222-4222-8222-222222222222', state: committed ? 'succeeded' : 'failed' });
            if (!committed) { expect(result.completions[0].result).toEqual({}); }
        }, 30_000,
    );

    it.each(['новый файл', 'симлинк', 'привязка', 'путь журнала', 'живой процесс', 'чужой lock'])(
        'Сценарий «%s» останавливает recovery и сохраняет исходный индекс', async scenario => {
            temporary = ''; await run('crash', 'after-first');
            const { file, value } = await journal();
            const settings = await fs.readFile(path.join(value.backup, 'runtime-overrides.json'), 'utf8');
            let original = value.backup;
            if (scenario === 'новый файл') { await fs.writeFile(path.join(value.stage, 'ручной.txt'), 'сохранить'); }
            if (scenario === 'симлинк') {
                original = path.join(temporary, 'original'); await fs.rename(value.backup, original);
                await fs.symlink(original, value.backup, 'dir');
            }
            if (scenario === 'привязка') {
                const marker = path.join(value.root, '.opencode/neurocenter.json');
                const binding = JSON.parse(await fs.readFile(marker, 'utf8'));
                await fs.writeFile(marker, JSON.stringify({ ...binding, instanceId: '99999999-9999-4999-8999-999999999999' }));
            }
            if (scenario === 'путь журнала') { await fs.writeFile(file, JSON.stringify({ ...value, backup: temporary })); }
            if (scenario === 'живой процесс') { await fs.writeFile(file, JSON.stringify({ ...value, pid: process.pid })); }
            if (scenario === 'чужой lock') { await fs.writeFile(path.join(value.backup, 'index.lock'), '{"pid":1}'); }
            const result = JSON.parse((await run('read')).output);
            expect(result.error).toBeTruthy(); expect(result.completions).toEqual([]);
            expect(await fs.readFile(path.join(original, 'runtime-overrides.json'), 'utf8')).toBe(settings);
            expect((await fs.lstat(path.join(original, 'chunks.lance'))).isDirectory()).toBe(true);
            expect(await fs.readFile(file, 'utf8')).toBeTruthy();
        }, 30_000,
    );

    it('Recovery не угадывает и не удаляет соседние previous-папки без intent', async () => {
        temporary = ''; await run('crash', 'before-cleanup');
        const { value } = await journal();
        const foreign = path.join(path.dirname(value.store), '.neurocenter-rag-restore-AAAAAA-previous');
        await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'личное.txt'), 'сохранить');
        const result = JSON.parse((await run('read')).output);
        expect(result.error).toBeUndefined(); expect(result.ids).toEqual(['server-row']);
        expect(await fs.readFile(path.join(foreign, 'личное.txt'), 'utf8')).toBe('сохранить');
        expect(result.leftovers).toEqual([path.basename(foreign)]);
    }, 30_000);
});
