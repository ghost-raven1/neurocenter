import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {measureDirectorySize,measureProjectDataSize} from '../src/catalog/fs-metrics';

describe('Честное и ограниченное измерение файлов проекта',()=>{
    let root:string;
    beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-fs-size-'));});
    afterEach(async()=>{vi.useRealTimers();vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});});
    const dataPath=(base:string)=>path.join(base,'.opencode');

    it('Считает обычные файлы вложенного каталога и возвращает ноль для пустого',async()=>{
        await fs.mkdir(dataPath(root));
        expect(await measureProjectDataSize(root)).toBe(0);
        await fs.writeFile(path.join(dataPath(root),'first'),'12345');
        await fs.mkdir(path.join(dataPath(root),'nested'));
        await fs.writeFile(path.join(dataPath(root),'nested','second'),'1234567');
        expect(await measureProjectDataSize(root)).toBe(12);
    });
    it('Не выдаёт отсутствие настроенной серверной папки за пустые данные',async()=>{
        for(const value of [undefined,null,'',path.join(root,'missing')]) {
            expect(await measureProjectDataSize(value)).toBeNull();
        }
        expect(await measureProjectDataSize(root)).toBe(0);
    });
    it('Не учитывает файлы по ссылкам вне данных проекта и не размножает циклы',async()=>{
        const project=path.join(root,'project');
        const outside=path.join(root,'outside');
        await fs.mkdir(dataPath(project),{recursive:true});
        await fs.mkdir(outside);
        await fs.writeFile(path.join(dataPath(project),'own'),'12345');
        await fs.writeFile(path.join(outside,'foreign'),'1234567');
        await fs.symlink(outside,path.join(dataPath(project),'foreign-directory'),'dir');
        await fs.symlink(path.join(outside,'foreign'),path.join(dataPath(project),'foreign-file'));
        await fs.symlink('.',path.join(dataPath(project),'cycle'),'dir');
        expect(await measureProjectDataSize(project)).toBe(5);
    });
    it('Не измеряет .opencode, заменённый ссылкой за пределы проекта',async()=>{
        const project=path.join(root,'project');
        const outside=path.join(root,'outside');
        await fs.mkdir(project);await fs.mkdir(outside);
        await fs.writeFile(path.join(outside,'foreign'),'1234567');
        await fs.symlink(outside,dataPath(project),'dir');
        expect(await measureProjectDataSize(project)).toBeNull();
    });
    it('Не возвращает частичную сумму при ошибке чтения файла',async()=>{
        await fs.mkdir(dataPath(root));
        const file=path.join(dataPath(root),'own');
        await fs.writeFile(file,'12345');
        const canonicalFile=await fs.realpath(file);
        const actual=fs.lstat.bind(fs);
        vi.spyOn(fs,'lstat').mockImplementation((async(value:unknown,...options:unknown[])=>{
            if(value===canonicalFile){throw Object.assign(new Error('Отказ чтения'),{code:'EACCES'});}
            return actual(value as string,...options as []);
        }) as typeof fs.lstat);
        expect(await measureProjectDataSize(root)).toBeNull();
    });
    it('Останавливает слишком глубокий обход и допускает повтор после исправления',async()=>{
        let nested=dataPath(root);await fs.mkdir(nested);
        for(let i=0;i<34;i++){nested=path.join(nested,'nested');await fs.mkdir(nested);}
        expect(await measureProjectDataSize(root)).toBeNull();
        await fs.rm(path.join(dataPath(root),'nested'),{recursive:true});
        await fs.writeFile(path.join(dataPath(root),'own'),'12345');
        expect(await measureProjectDataSize(root)).toBe(5);
    });
    it('Ограничивает число элементов, даже если каталог продолжает выдавать имена',async()=>{
        const actual=fs.opendir.bind(fs);
        const iterator={async *[Symbol.asyncIterator](){for(let i=0;i<10001;i++){yield {name:'own'};}}};
        await fs.writeFile(path.join(root,'own'),'1');
        vi.spyOn(fs,'opendir').mockImplementation((async(value:unknown,...options:unknown[])=>value===root?iterator:actual(value as string,...options as [])) as typeof fs.opendir);
        expect(await measureDirectorySize(root)).toBeNull();
    });
    it('Возвращает неизвестный размер при зависшем I/O и не продолжает обход после таймаута',async()=>{
        vi.useFakeTimers();
        let release:()=>void=()=>{};
        let reads=0;
        const stats=vi.spyOn(fs,'lstat');
        const iterator={async *[Symbol.asyncIterator](){reads++;yield {name:'own'};}};
        vi.spyOn(fs,'opendir').mockImplementation((async()=>{
            await new Promise<void>(resolve=>{release=resolve;});return iterator;
        }) as typeof fs.opendir);
        const pending=measureDirectorySize(root);
        await vi.waitFor(()=>expect(fs.opendir).toHaveBeenCalled());
        const beforeTimeout=stats.mock.calls.length;
        await vi.advanceTimersByTimeAsync(1001);
        expect(await pending).toBeNull();
        release();await Promise.resolve();await Promise.resolve();
        expect(reads).toBeLessThanOrEqual(1);
        expect(stats.mock.calls.length).toBe(beforeTimeout);
    });
});
