import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {clearStoredBuildDraft,readStoredBuildDraft,saveStoredBuildDraft} from '../src/modules/Store/packaging/buildDraftStore';
import type {ToolBuildRequest} from '../src/modules/Store/packaging/types';

const key='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const request=():ToolBuildRequest=>({requestKey:key,kind:'mcp',name:'Тестовый MCP',description:'Описание',source:{type:'files',entrypoint:'src/index.ts',files:[{path:'src/index.ts',content:'console.log("исходная версия");\n'}]}});
beforeEach(()=>vi.stubGlobal('indexedDB',new IDBFactory()));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('Платформы в точном сохранённом запросе',()=>{
    it('Сохраняет порядок платформ, восстанавливает exact bytes и не меняет targets под прежним UUID',async()=>{
        const exact={...request(),targets:['darwin-arm64','linux-x64-glibc']};
        await saveStoredBuildDraft('platforms',exact);const restored=await readStoredBuildDraft('platforms');
        expect(JSON.stringify(restored!.request)).toBe(JSON.stringify(exact));
        await expect(saveStoredBuildDraft('platforms',{...exact,targets:['linux-x64-glibc','darwin-arm64']})).rejects.toThrow('Уже сохранён другой запрос');
        expect((await readStoredBuildDraft('platforms'))!.request).toEqual(exact);
    });
    it.each([[],['unknown'],['darwin-arm64','darwin-arm64'],null,'darwin-arm64'])('Отклоняет повреждённый набор %j без сохранения',async targets=>{
        await expect(saveStoredBuildDraft('invalid-targets',{...request(),targets} as ToolBuildRequest)).rejects.toThrow('повреждён');
        expect(await readStoredBuildDraft('invalid-targets')).toBeUndefined();
    });
    it('Чтение повреждённого targets не делает запрос пригодным для повтора',async()=>{
        await saveStoredBuildDraft('damaged',request());await rawRecord({scope:'damaged',schemaVersion:1,requestJSON:JSON.stringify({...request(),targets:['unknown']})});
        await expect(readStoredBuildDraft('damaged')).rejects.toThrow('повреждён');
    });
    it('Старый запрос без targets остаётся валидным, а скилл с платформами отклоняется',async()=>{
        await saveStoredBuildDraft('legacy',request());expect((await readStoredBuildDraft('legacy'))!.request).not.toHaveProperty('targets');
        await expect(saveStoredBuildDraft('skill',{...request(),kind:'skill',targets:['darwin-arm64'],source:{type:'files',entrypoint:'SKILL.md',files:[{path:'SKILL.md',content:'---\nname: test\ndescription: Test\n---\nTest'}]}})).rejects.toThrow('повреждён');
    });
});

async function rawRecord(value:unknown):Promise<void>{
    const database=await new Promise<IDBDatabase>((resolve,reject)=>{const open=indexedDB.open('neurocenter-tool-builds',3);open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
    try{await new Promise<void>((resolve,reject)=>{const tx=database.transaction('requests','readwrite');tx.objectStore('requests').put(value);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});}
    finally{database.close();}
}

describe('Durable exact request упаковщика',()=>{
    it('Новая версия сохраняет точную цель CAS вместе с исходниками и UUID',async()=>{
        const value={...request(),publication:{catalogId:'native-tool',expectedVersion:7,expectedSourceHash:'b'.repeat(64)}};
        await saveStoredBuildDraft('alice',value);expect((await readStoredBuildDraft('alice'))?.request).toEqual(value);
        await expect(saveStoredBuildDraft('alice',{...value,publication:{...value.publication,expectedVersion:8}})).rejects.toThrow('другой запрос');
        expect((await readStoredBuildDraft('alice'))?.request).toEqual(value);
    });
    it.each([null,{}, {catalogId:' ',expectedVersion:1,expectedSourceHash:'b'.repeat(64)},
        {catalogId:'native',expectedVersion:0,expectedSourceHash:'b'.repeat(64)},
        {catalogId:'native',expectedVersion:1.5,expectedSourceHash:'b'.repeat(64)},
        {catalogId:'native',expectedVersion:1,expectedSourceHash:'bad'},
        {catalogId:'native',expectedVersion:1,expectedSourceHash:'b'.repeat(64),origins:[]},
    ])('Повреждённая цель публикации %j не допускается в POST',async publication=>{
        await expect(saveStoredBuildDraft('alice',{...request(),publication} as ToolBuildRequest)).rejects.toThrow();
        expect(await readStoredBuildDraft('alice')).toBeUndefined();
    });
    it.each(['files','repository'] as const)('Восстанавливает skill %s с точным SKILL.md и ресурсами',async type=>{
        const value:ToolBuildRequest={...request(),kind:'skill',source:type==='files'?{type,entrypoint:'SKILL.md',files:[{path:'SKILL.md',content:'---\nname: review\ndescription: Проверка\n---\nТекст'},{path:'references/check.md',content:'Границы'}]}:{type,url:'https://github.com/team/skills',ref:'a'.repeat(40),entrypoint:'SKILL.md',subdirectory:'skills/review'}};
        await saveStoredBuildDraft('alice',value);expect((await readStoredBuildDraft('alice'))?.request).toEqual(value);
    });
    it('Сохраняет явный выбор вложенного SKILL.md при повторном открытии',async()=>{
        const value:ToolBuildRequest={...request(),kind:'skill',source:{type:'files',entrypoint:'download/selected/SKILL.md',files:[{path:'download/selected/SKILL.md',content:'Инструкция'},{path:'other/SKILL.md',content:'Другая инструкция'}]}};
        await saveStoredBuildDraft('alice',value);expect((await readStoredBuildDraft('alice'))?.request).toEqual(value);
    });
    it('Восстанавливает exact base64 бинарных ресурсов скилла без UTF-8 преобразований',async()=>{
        const value:ToolBuildRequest={...request(),kind:'skill',source:{type:'files',entrypoint:'SKILL.md',files:[{path:'SKILL.md',content:'---\nname: review\ndescription: Проверка\n---\nИнструкция'},{path:'assets/image.png',content:'iVBORw0KGgoA//4=',encoding:'base64'}]}};
        await saveStoredBuildDraft('alice',value);expect((await readStoredBuildDraft('alice'))?.request).toEqual(value);
    });
    it.each([
        {type:'npm',specifier:'skill@1.0.0'},
        {type:'upload',uploadId:other,sha256:'a'.repeat(64),bytes:100,entrypoint:'SKILL.md'},
        {type:'files',entrypoint:'index.ts',files:[{path:'SKILL.md',content:'Текст'}]},
        {type:'files',entrypoint:'SKILL.md',files:[{path:'SKILL.md',content:'Текст'}],args:['--run']},
    ])('Повреждённый skill source %j не восстанавливается в POST',async source=>{
        await expect(saveStoredBuildDraft('alice',{...request(),kind:'skill',source} as ToolBuildRequest)).rejects.toThrow();
    });
    it('После закрытия соединения восстанавливает UUID и все исходные байты',async()=>{
        const original=request();await saveStoredBuildDraft('alice',original);
        original.source.type==='files'&& (original.source.files[0].content='изменено после сохранения');
        const recovered=await readStoredBuildDraft('alice');
        expect(recovered?.request.requestKey).toBe(key);
        expect(recovered?.request.source).toEqual(request().source);
        expect(await readStoredBuildDraft('bob')).toBeUndefined();
    });
    it.each(['npm','repository'] as const)('Сохраняет точный %s pin и подпапку без повторного определения',async type=>{
        const value=request();value.source=type==='npm'?{type,specifier:'@scope/tool@1.2.3'}:{type,url:'https://github.com/example/tool',ref:'a'.repeat(40),subdirectory:'packages/mcp',entrypoint:'src/main.ts'};
        await saveStoredBuildDraft('alice',value);expect((await readStoredBuildDraft('alice'))?.request).toEqual(value);
    });
    it('Сохраняет выбранную npm-команду и полную identity GitHub Release',async()=>{
        const npm={...request(),source:{type:'npm' as const,specifier:'@scope/tool@1.2.3',entrypoint:'dist/second.js'}};
        await saveStoredBuildDraft('alice',npm);expect((await readStoredBuildDraft('alice'))?.request).toEqual(npm);
        const release={...request(),source:{type:'repository' as const,url:'https://github.com/example/tool',ref:'a'.repeat(40),entrypoint:'bin/server',release:{tag:'v1.2.3',asset:'tool-linux-x64.tar.gz',id:12,assetId:34,sha256:'b'.repeat(64)}}};
        await saveStoredBuildDraft('bob',release);expect((await readStoredBuildDraft('bob'))?.request).toEqual(release);
    });
    it('Восстанавливает точный handle готового архива без хранения тяжёлых байтов',async()=>{
        const value={...request(),source:{type:'upload' as const,uploadId:other,sha256:'a'.repeat(64),bytes:256*1024**2,entrypoint:'bin/server'}};
        await saveStoredBuildDraft('alice',value);const restored=(await readStoredBuildDraft('alice'))!.request;
        expect(restored).toEqual(value);expect(JSON.stringify(restored).length).toBeLessThan(512);
    });
    it.each([
        {type:'npm'}, {type:'npm',specifier:2}, {type:'npm',specifier:'tool@1.0.0',entrypoint:[]},
        {type:'repository',url:'https://github.com/example/tool',entrypoint:'index.ts'},
        {type:'repository',url:'https://github.com/example/tool',ref:'main',entrypoint:'index.ts'},
        {type:'repository',url:'https://github.com/example/tool',ref:'a'.repeat(40),entrypoint:'index.ts',subdirectory:3},
        {type:'repository',url:'https://github.com/example/tool',ref:'a'.repeat(40),entrypoint:'bin/server',release:{tag:'v1',id:12}},
        {type:'repository',url:'https://github.com/example/tool',ref:'a'.repeat(40),entrypoint:'bin/server',release:{tag:'v1',asset:'tool.zip',id:12,assetId:-1,sha256:'b'.repeat(64)}},
        {type:'files',entrypoint:'index.ts'}, {type:'files',entrypoint:'index.ts',files:[null]},
        {type:'files',entrypoint:'index.ts',files:[{path:'index.ts',content:42}]},
        {type:'files',entrypoint:'index.ts',files:[{path:'index.ts',content:''}],args:[null]},
        {type:'upload',uploadId:other,sha256:'a'.repeat(64),bytes:0,entrypoint:'bin/server'},
        {type:'upload',uploadId:other,sha256:'a'.repeat(64),bytes:256*1024**2+1,entrypoint:'bin/server'},
        {type:'upload',uploadId:other,sha256:'bad',bytes:256,entrypoint:'bin/server'},
        {type:'upload',uploadId:'not-a-uuid',sha256:'a'.repeat(64),bytes:256,entrypoint:'bin/server'},
        {type:'upload',uploadId:other,sha256:'a'.repeat(64),bytes:256,entrypoint:'bin/server',contentBase64:'do-not-retain'},
    ])('Повреждённый source %j блокируется до восстановления формы',async source=>{
        await readStoredBuildDraft('alice');const value={...request(),source};
        await rawRecord({scope:'alice',schemaVersion:1,requestJSON:JSON.stringify(value)});
        await expect(readStoredBuildDraft('alice')).rejects.toThrow('повреждён');
        await expect(saveStoredBuildDraft('alice',request())).rejects.toThrow('повреждён');
    });
    it('Повтор того же UUID и тела идемпотентен',async()=>{
        await saveStoredBuildDraft('alice',request());await saveStoredBuildDraft('alice',request());
        expect((await readStoredBuildDraft('alice'))?.request).toEqual(request());
    });
    it.each(['body','key'] as const)('Не подменяет активный запрос при изменении %s',async change=>{
        await saveStoredBuildDraft('alice',request());const modified=request();if(change==='body')modified.name='Другая форма';else modified.requestKey=other;
        await expect(saveStoredBuildDraft('alice',modified)).rejects.toThrow('другой запрос');
        expect((await readStoredBuildDraft('alice'))?.request).toEqual(request());
    });
    it('Два окна не перезаписывают друг друга: commit получает ровно один intent',async()=>{
        const a=request(),b={...request(),requestKey:other,name:'Вторая вкладка'};
        const results=await Promise.allSettled([saveStoredBuildDraft('alice',a),saveStoredBuildDraft('alice',b)]);
        expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
        const winner=results.find(result=>result.status==='fulfilled');
        expect((await readStoredBuildDraft('alice'))?.request).toEqual(winner?.status==='fulfilled'?winner.value.request:undefined);
    });
    it('Поздняя очистка прежней операции сохраняет следующую и другого пользователя',async()=>{
        await saveStoredBuildDraft('alice',request());await saveStoredBuildDraft('bob',request());expect(await clearStoredBuildDraft('alice',key)).toBe(true);
        const next={...request(),requestKey:other};await saveStoredBuildDraft('alice',next);expect(await clearStoredBuildDraft('alice',key)).toBe(false);
        expect((await readStoredBuildDraft('alice'))?.request).toEqual(next);expect((await readStoredBuildDraft('bob'))?.request).toEqual(request());
    });
    it('Сброс без локального intent проверяет отсутствие запроса другой вкладки',async()=>{
        expect(await clearStoredBuildDraft('alice')).toBe(true);await saveStoredBuildDraft('alice',request());
        expect(await clearStoredBuildDraft('alice')).toBe(false);expect((await readStoredBuildDraft('alice'))?.request).toEqual(request());
    });
    it('Успешный put с последующим abort не выдаётся за durable commit',async()=>{
        const original=IDBObjectStore.prototype.put;
        const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){
            const write=original.apply(this,args);write.addEventListener('success',()=>this.transaction.abort());return write;
        });
        await expect(saveStoredBuildDraft('alice',request())).rejects.toThrow();spy.mockRestore();
        expect(await readStoredBuildDraft('alice')).toBeUndefined();
    });
    it('QuotaExceededError не оставляет частичный запрос',async()=>{
        const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw new DOMException('Disk full','QuotaExceededError');});
        await expect(saveStoredBuildDraft('alice',request())).rejects.toThrow('Disk full');spy.mockRestore();expect(await readStoredBuildDraft('alice')).toBeUndefined();
    });
    it('Отказ IndexedDB не превращается в молчаливое хранение только UUID',async()=>{
        vi.stubGlobal('indexedDB',{open:()=>{throw new DOMException('Storage denied','SecurityError');}});
        await expect(saveStoredBuildDraft('alice',request())).rejects.toThrow('Хранилище запросов');
    });
    it('Повреждённое тело не удаляется и не разрешает записать новую форму поверх него',async()=>{
        await readStoredBuildDraft('alice');await rawRecord({scope:'alice',schemaVersion:1,requestJSON:'{broken'});
        await expect(readStoredBuildDraft('alice')).rejects.toThrow();await expect(saveStoredBuildDraft('alice',request())).rejects.toThrow();
    });
    it.each([undefined,'', 'not-a-uuid'])('Некорректный UUID %s отклоняется до создания БД',async requestKey=>{
        const open=vi.spyOn(indexedDB,'open');await expect(saveStoredBuildDraft('alice',{...request(),requestKey} as ToolBuildRequest)).rejects.toThrow();expect(open).not.toHaveBeenCalled();
    });
    it('Нельзя прочитать под чужим scope или schema неизвестную запись',async()=>{
        await readStoredBuildDraft('alice');await rawRecord({scope:'alice',schemaVersion:2,requestJSON:JSON.stringify(request())});
        await expect(readStoredBuildDraft('alice')).rejects.toThrow('повреждён');
    });
    it.each(['blocked','deadline'] as const)('Ожидание открытия %s ограничено; поздний handle закрывается',async mode=>{
        vi.useFakeTimers();
        const close=vi.fn(),pending:{onerror?:()=>void;onblocked?:()=>void;onsuccess?:()=>void;result:{close:()=>void}}={result:{close}};
        vi.stubGlobal('indexedDB',{open:()=>pending});
        const result=readStoredBuildDraft('alice').catch(cause=>cause);
        if(mode==='blocked')pending.onblocked?.();else await vi.advanceTimersByTimeAsync(5000);
        expect(await result).toBeInstanceOf(Error);pending.onsuccess?.();expect(close).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();
    });
});
