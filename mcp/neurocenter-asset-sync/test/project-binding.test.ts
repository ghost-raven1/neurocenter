import {mkdtemp,mkdir,writeFile,rm,lstat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {resolveProjectKey} from '../src/tools/resolve-project-key.js';

describe('Привязка локальной папки к серверному проекту',()=>{
    let root:string;
    beforeEach(async()=>{root=await mkdtemp(path.join(tmpdir(),'neurocenter-binding-'));});
    afterEach(async()=>{vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});});
    it('Использует серверный ID при другом названии локальной папки',async()=>{
        await mkdir(path.join(root,'.opencode'));
        await writeFile(path.join(root,'.opencode/neurocenter.json'),JSON.stringify({version:1,projectId:'prj-server-id',server:'http://localhost:5173'}));
        expect(JSON.parse(await resolveProjectKey({},root))).toMatchObject({ok:true,projectKey:'prj-server-id',matchedBy:'binding',accessVerified:false});
    });
    it('Без привязки не угадывает проект и не создаёт его даже с устаревшим флагом',async()=>{
        const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
        expect(JSON.parse(await resolveProjectKey({createIfMissing:true},root))).toMatchObject({ok:false,error:'project-binding-required'});
        expect(fetch).not.toHaveBeenCalled();
    });
    it('Относительная папка разрешается от переданного cwd, а не от каталога процесса MCP',async()=>{
        await mkdir(path.join(root,'relative/.opencode'),{recursive:true});
        await writeFile(path.join(root,'relative/.opencode/neurocenter.json'),JSON.stringify({version:1,projectId:'prj-relative',server:'http://localhost:5173'}));
        expect(JSON.parse(await resolveProjectKey({project:'relative'},root))).toMatchObject({ok:true,projectKey:'prj-relative'});
    });
    it.each(['{bad',JSON.stringify({version:1,projectId:'prj-id',server:'https://token:secret@example.org'}),JSON.stringify({version:2,projectId:'prj-id',server:'https://example.org'})])('Не использует некорректный файл: %s',async raw=>{
        await mkdir(path.join(root,'.opencode'));
        await writeFile(path.join(root,'.opencode/neurocenter.json'),raw);
        expect(JSON.parse(await resolveProjectKey({},root))).toMatchObject({ok:false,error:'project-binding-invalid'});
    });
    it('Публичный resolver отклоняет валидный marker больше 64 КиБ без изменения файла',async()=>{
        await mkdir(path.join(root,'.opencode'));
        const file=path.join(root,'.opencode/neurocenter.json');
        await writeFile(file,' '.repeat(64*1024)+JSON.stringify({version:1,projectId:'prj-id',server:'http://localhost:5173'}));
        const before=await lstat(file);
        expect(JSON.parse(await resolveProjectKey({},root))).toMatchObject({ok:false,error:'project-binding-unreadable'});
        const after=await lstat(file);expect(after.size).toBe(before.size);expect(after.mtimeMs).toBe(before.mtimeMs);
    });
    it.skipIf(process.platform==='win32')('Публичный resolver не зависает на настоящем FIFO вместо marker',async()=>{
        await mkdir(path.join(root,'.opencode'));
        const file=path.join(root,'.opencode/neurocenter.json');execFileSync('mkfifo',[file]);
        const before=await lstat(file);const start=Date.now();
        expect(JSON.parse(await resolveProjectKey({},root))).toMatchObject({ok:false,error:'project-binding-unreadable'});
        expect(Date.now()-start).toBeLessThan(1000);
        const after=await lstat(file);expect(after.isFIFO()).toBe(true);expect(after.ino).toBe(before.ino);expect(after.mtimeMs).toBe(before.mtimeMs);
    });
});
