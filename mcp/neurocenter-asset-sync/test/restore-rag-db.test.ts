import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreRagDb } from '../src/tools/restore-rag-db.js';
import { enumerateIds, enumerateRows, writeRows } from '../src/lib/lancedb.js';
import * as lance from '../src/lib/lancedb.js';
import { readState, writeState } from '../src/bridge/state.js';
import { workspaceFixture } from './bridge-fixture.js';
import { readyIndex, row, metadata, profile } from './rag-index-fixture.js';
import { locateStore } from '../src/lib/store.js';
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/bridge/state.js', async original => ({ ...await original<typeof import('../src/bridge/state.js')>(), authorizedFetch: transport.fetch }));

describe('Атомарное восстановление RAG в подтверждённый экземпляр', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    let store: string;
    let source: ReturnType<typeof row>[];
    const page = (rows = source, hasMore = false) => Response.json({ ...metadata(source), chunks: rows, hasMore });
    const ids = async (location = store) => { const values: string[] = []; for await (const id of enumerateIds(location)) { values.push(id); } return values.sort(); };
    const changeGeneration = async () => {
        const marker = JSON.parse(await fs.readFile(path.join(fixture.root, '.opencode/neurocenter.json'), 'utf8'));
        const registry = (await readState<{ instances: Record<string, { bindingNonce: string }> }>('workspace-instances'))!;
        registry.instances[marker.instanceId]!.bindingNonce = randomUUID(); await writeState('workspace-instances', registry);
    };
    const run = () => restoreRagDb({ projectKey: 'test-project', project: fixture.root }, fixture.root);
    beforeEach(async () => {
        fixture = await workspaceFixture(); store = path.join(fixture.root, '.opencode/rag_db');
        await readyIndex(fixture.root); await writeRows(store, [row('local-original')], false, 3);
        source = [row('server-row')];
        transport.fetch.mockReset().mockImplementation(async (route: string) => route.includes('/manifest') ? Response.json(metadata(source)) : page());
    });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });

    it('Меняет индекс только целиком и перебазирует пути на текущую папку', async () => {
        source = [row('restored-a'), row('restored-b')];
        expect(JSON.parse(await run())).toMatchObject({ ok: true, complete: true, written: 2, sourceCount: 2, indexProfile: profile });
        expect(await ids()).toEqual(['restored-a', 'restored-b']);
        for await (const value of enumerateRows(store)) { expect(value.filePath).toBe(path.join(fixture.root, 'README.md')); }
        expect(await fs.readFile(path.join(store, 'neurocenter-restored.json'), 'utf8')).toContain('"complete":true');
        await expect(fs.stat(path.join(store, 'watcher-status.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('Относительный project разрешается от cwd', async () => {
        expect(JSON.parse(await restoreRagDb({ projectKey: 'test-project', project: path.basename(fixture.root) }, path.dirname(fixture.root)))).toMatchObject({ complete: true });
    });
    it('Отсутствующая локальная таблица допускает восстановление в безопасный default path', async () => {
        await fs.rm(store, { recursive: true });
        expect(JSON.parse(await run())).toMatchObject({ complete: true }); expect(await ids()).toEqual(['server-row']);
    });
    it('ID другого проекта не заменяет подтверждённую привязку', async () => {
        expect(JSON.parse(await restoreRagDb({ projectKey: 'other-project', project: fixture.root }, fixture.root))).toMatchObject({ error: 'project-instance-unverified' });
        expect(await ids()).toEqual(['local-original']); expect(transport.fetch).not.toHaveBeenCalled();
    });
    it.each(['missing', 'legacy', 'copy'])('Неподтверждённая привязка %s не скачивает и не меняет индекс', async mode => {
        let root = fixture.root; const marker = path.join(root, '.opencode/neurocenter.json');
        if (mode === 'missing') { await fs.rm(marker); }
        else if (mode === 'legacy') { await fs.writeFile(marker, JSON.stringify({ version: 1, server: 'http://localhost:5173', projectId: 'test-project' })); }
        else { root = path.join(fixture.temporary, 'copy'); await fs.cp(fixture.root, root, { recursive: true }); }
        expect(JSON.parse(await restoreRagDb({ projectKey: 'test-project', project: root }, root))).toMatchObject({ error: 'project-instance-unverified' });
        expect(await ids()).toEqual(['local-original']); expect(transport.fetch).not.toHaveBeenCalled();
    });
    it.each(['config', 'symlink'])('Внешний store через %s отклоняется до HTTP', async mode => {
        const outside = path.join(fixture.temporary, 'outside'); await writeRows(outside, [row('outside-original')], false, 3);
        if (mode === 'config') { await fs.writeFile(path.join(fixture.root, 'opencode-rag.json'), JSON.stringify({ vectorStore: { path: outside } })); }
        else { await fs.rm(store, { recursive: true }); await fs.symlink(outside, store, 'dir'); }
        await expect(run()).rejects.toThrow(/внутри|симлинк/); expect(await ids(outside)).toEqual(['outside-original']); expect(transport.fetch).not.toHaveBeenCalled();
    });
    it.each(['watcher.lock', 'index.lock', 'neurocenter-session.lock', 'neurocenter-ui-session.lock'])('Живой native %s блокирует восстановление до HTTP', async name => {
        await fs.writeFile(path.join(store, name), JSON.stringify({ pid: process.pid }));
        await expect(run()).rejects.toThrow(/Закройте (?:интерфейс )?OpenCode|Идёт индексация/); expect(await ids()).toEqual(['local-original']); expect(transport.fetch).not.toHaveBeenCalled();
    });
    it('Незапечатанный или legacy источник не создаёт staging', async () => {
        transport.fetch.mockResolvedValue(Response.json({ projectKey: 'test-project', chunks: source, dimension: 3, hasMore: false }));
        await expect(run()).rejects.toThrow('V1'); expect(await ids()).toEqual(['local-original']);
    });
    it('Другая модель отклоняется до первой staging-записи', async () => {
        transport.fetch.mockResolvedValue(Response.json({ ...metadata(source), indexProfile: { ...profile, model: 'different' }, chunks: source, hasMore: false }));
        const write = vi.spyOn(lance, 'writeRows'); await expect(run()).rejects.toThrow('Модели'); expect(write).not.toHaveBeenCalled(); expect(await ids()).toEqual(['local-original']);
    });
    it.each(['/foreign/README.md', '../README.md', 'C:/private/file.ts', 'dir/../secret.ts'])('Небезопасный серверный путь %s не импортируется', async filePath => {
        source = [{ ...row('server-row'), filePath }];
        await expect(run()).rejects.toThrow('небезопасный путь'); expect(await ids()).toEqual(['local-original']);
    });
    it('Виртуальная quirk-запись сохраняется как виртуальная', async () => {
        source = [{ ...row('remember'), filePath: 'quirk:remember', kind: 'quirk' }];
        expect(JSON.parse(await run())).toMatchObject({ complete: true });
        for await (const value of enumerateRows(store)) { expect(value.filePath).toBe('quirk:remember'); }
    });
    it('Отказ второй страницы не меняет исходный индекс, повтор заменяет его без дублей', async () => {
        source = [row('first'), row('second')];
        transport.fetch.mockImplementationOnce(async () => page([source[0]!], true)).mockResolvedValueOnce(new Response('internal-secret', { status: 503 }));
        await expect(run()).rejects.toThrow('503'); expect(await ids()).toEqual(['local-original']);
        expect(JSON.parse(await run())).toMatchObject({ complete: true, written: 2 }); expect(await ids()).toEqual(['first', 'second']);
    });
    it('Смена snapshotHash между страницами отбрасывает staging', async () => {
        source = [row('first'), row('second')];
        transport.fetch.mockImplementationOnce(async () => page([source[0]!], true)).mockImplementationOnce(async () => {
            source = [row('other')]; return page();
        });
        await expect(run()).rejects.toThrow('снимок изменился'); expect(await ids()).toEqual(['local-original']);
    });
    it('Другое поколение с тем же snapshotHash между страницами не становится источником восстановления', async () => {
        source = [row('first'), row('second')];
        transport.fetch.mockImplementationOnce(async () => page([source[0]!], true)).mockImplementationOnce(async route => {
            expect(new URL(route,'http://fixture').searchParams.get('generation')).toBe(metadata(source).generation);
            return Response.json({ ...metadata(source),generation:'initial-'+'e'.repeat(32),chunks:[source[1]!],hasMore:false });
        });
        await expect(run()).rejects.toThrow('снимок изменился'); expect(await ids()).toEqual(['local-original']);
    });
    it('Смена активного поколения перед commit сохраняет исходный индекс даже при одинаковых строках', async () => {
        transport.fetch.mockImplementation(async route => route.includes('/manifest')
            ? Response.json({...metadata(source),generation:'initial-'+'e'.repeat(32)}) : page());
        await expect(run()).rejects.toThrow('Снимок изменился перед сохранением');expect(await ids()).toEqual(['local-original']);
    });
    it('Недостающая строка не проходит проверку полного хеша', async () => {
        source = [row('first'), row('second')]; transport.fetch.mockImplementation(async () => page([source[0]!], false));
        await expect(run()).rejects.toThrow('Полнота'); expect(await ids()).toEqual(['local-original']);
    });
    it('Изменённые строки при прежней метке снимка не проходят полный хеш', async () => {
        transport.fetch.mockImplementation(async () => page([{ ...source[0]!, description: 'concurrent-change' } as any]));
        await expect(run()).rejects.toThrow('Полнота'); expect(await ids()).toEqual(['local-original']);
    });
    it('Новое локальное изменение во время скачивания не перезаписывается', async () => {
        transport.fetch.mockImplementationOnce(async () => { await writeRows(store, [row('local-new')], false, 3); return page(); });
        await expect(run()).rejects.toThrow('индекс изменился'); expect(await ids()).toEqual(['local-new', 'local-original']);
    });
    it('Ошибка финального rename возвращает исходный индекс из собственной резервной папки', async () => {
        const rename = fs.rename;
        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
            if (String(from).includes('.neurocenter-rag-restore-') && !String(from).endsWith('-previous') && to === store) { throw Object.assign(new Error('fixture rename failed'), { code: 'EACCES' }); }
            return rename(from, to);
        });
        await expect(run()).rejects.toThrow('fixture rename failed'); expect(await ids()).toEqual(['local-original']);
        expect((await fs.readdir(path.dirname(store))).filter(name => name.startsWith('.neurocenter-rag-restore-'))).toEqual([]);
    });
    it('Повторная ошибка rollback сохраняет intent и допускает восстановление без новой передачи в том же процессе', async () => {
        const rename = fs.rename;
        const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
            if (String(from).includes('.neurocenter-rag-restore-') && to === store) { throw new Error('Отказ переключения и отката'); }
            return rename(from, to);
        });
        await expect(run()).rejects.toMatchObject({ restoreRecoveryPending: true });
        failure.mockRestore(); transport.fetch.mockClear();
        await locateStore(fixture.root, fixture.root); await locateStore(fixture.root, fixture.root);
        expect(await ids()).toEqual(['local-original']); expect(transport.fetch).not.toHaveBeenCalled();
        expect((await fs.readdir(path.dirname(store))).filter(name => name.startsWith('.neurocenter-rag-restore-'))).toEqual([]);
    });
    it('Ошибка очистки после commit сохраняет новый индекс и завершается чтением без повторной загрузки', async () => {
        const remove = fs.rm;
        const failure = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
            if (String(file).endsWith('-previous')) { throw new Error('Резервная папка временно занята'); }
            return remove(file, options);
        });
        await expect(run()).rejects.toMatchObject({ restoreRecoveryPending: true });
        failure.mockRestore(); transport.fetch.mockClear();
        await locateStore(fixture.root, fixture.root);
        expect(await ids()).toEqual(['server-row']); expect(transport.fetch).not.toHaveBeenCalled();
        expect((await fs.readdir(path.dirname(store))).filter(name => name.startsWith('.neurocenter-rag-restore-'))).toEqual([]);
    });
    it('Текущие runtime-настройки сохраняются, служебная история native-прохода не подделывается', async () => {
        const settings = JSON.stringify({ retrieval: { topK: 17 } });
        await fs.writeFile(path.join(store, 'runtime-overrides.json'), settings);
        expect(JSON.parse(await run())).toMatchObject({ complete: true });
        expect(await fs.readFile(path.join(store, 'runtime-overrides.json'), 'utf8')).toBe(settings);
        expect(JSON.parse(await fs.readFile(path.join(store, 'neurocenter-index-profile.json'), 'utf8'))).toMatchObject({ state: 'ready', profile });
        await expect(fs.stat(path.join(store, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.stat(path.join(store, 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('Вторая native-попытка во время скачивания видит живую эксклюзивную блокировку', async () => {
        source = [row('first'), row('second')];
        transport.fetch.mockImplementationOnce(async () => page([source[0]!], true)).mockImplementationOnce(async () => {
            const lock = JSON.parse(await fs.readFile(path.join(store, 'index.lock'), 'utf8'));
            expect(lock.pid).toBe(process.pid); expect(lock.neurocenterRestore).toMatch(/^[a-f0-9-]{36}$/);
            await expect(fs.writeFile(path.join(store, 'index.lock'), '{}', { flag: 'wx' })).rejects.toMatchObject({ code: 'EEXIST' });
            return page([source[1]!]);
        });
        expect(JSON.parse(await run())).toMatchObject({ complete: true });
        await expect(fs.stat(path.join(store, 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('Подмена чужим lock не удаляется и не разрешает commit', async () => {
        source = [row('first'), row('second')]; const foreign = JSON.stringify({ pid: process.pid, foreign: true });
        transport.fetch.mockImplementationOnce(async () => page([source[0]!], true)).mockImplementationOnce(async () => {
            await fs.writeFile(path.join(store, 'index.lock'), foreign); return page([source[1]!]);
        });
        await expect(run()).rejects.toThrow('Блокировка индекса изменилась');
        expect(await fs.readFile(path.join(store, 'index.lock'), 'utf8')).toBe(foreign); expect(await ids()).toEqual(['local-original']);
    });
    it('После аварии восстанавливает только собственный restore-lock с мёртвым PID', async () => {
        await fs.writeFile(path.join(store, 'index.lock'), JSON.stringify({ pid: 2_000_000_000, startedAt: 1, neurocenterRestore: '11111111-1111-4111-8111-111111111111' }));
        expect(JSON.parse(await run())).toMatchObject({ complete: true });
        await expect(fs.stat(path.join(store, 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('Устаревшую чужую native-блокировку не удаляет при восстановлении', async () => {
        const raw = JSON.stringify({ pid: 2_000_000_000, startedAt: 1, owner: 'native-other' });
        await fs.writeFile(path.join(store, 'index.lock'), raw);
        await expect(run()).rejects.toThrow('уже заблокирован');
        expect(await fs.readFile(path.join(store, 'index.lock'), 'utf8')).toBe(raw); expect(await ids()).toEqual(['local-original']);
    });
    it('Расхождение реально записанной LanceDB с входящими строками отменяет commit', async () => {
        const write = lance.writeRows;
        vi.spyOn(lance, 'writeRows').mockImplementation((location, rows, ...rest) => write(location, rows.map(row => ({ ...row, content: 'corrupted-after-transfer' })), ...rest));
        await expect(run()).rejects.toThrow('записанного LanceDB'); expect(await ids()).toEqual(['local-original']);
        await expect(fs.stat(path.join(store, 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('Пустая промежуточная страница не очищает исходные данные', async () => {
        transport.fetch.mockImplementation(async () => page([], true));
        await expect(run()).rejects.toThrow('неполный или пустой'); expect(await ids()).toEqual(['local-original']);
    });
    it('Подмена проекта сервером отклоняется до записи', async () => {
        transport.fetch.mockResolvedValue(Response.json({ ...metadata(source), projectKey: 'other', chunks: source, hasMore: false }));
        await expect(run()).rejects.toThrow('другого проекта'); expect(await ids()).toEqual(['local-original']);
    });
    it('Смена bindingNonce после staging-записи сохраняет исходные строки', async () => {
        const write = lance.writeRows;
        vi.spyOn(lance, 'writeRows').mockImplementation(async (...args) => { const result = await write(...args); await changeGeneration(); return result; });
        await expect(run()).rejects.toThrow('экземпляра изменилась'); expect(await ids()).toEqual(['local-original']);
    });
    it('Смена vectorStore в ходе скачивания не перенаправляет commit', async () => {
        transport.fetch.mockImplementationOnce(async () => {
            await fs.writeFile(path.join(fixture.root, 'opencode-rag.json'), JSON.stringify({ vectorStore: { path: './other' } })); return page();
        });
        await expect(run()).rejects.toThrow('Путь локального индекса изменился'); expect(await ids()).toEqual(['local-original']);
    });
    it('Отозванная binding-aware авторизация прямо перед commit сохраняет исходный индекс', async () => {
        let sealedRead = false;
        const implementation = transport.fetch.getMockImplementation()!;
        transport.fetch.mockImplementation(async (route, options) => { const response = await implementation(route, options); if (route.includes('/manifest')) { sealedRead = true; } return response; });
        await expect(restoreRagDb({ projectKey: 'test-project', project: fixture.root }, fixture.root, async () => { if (sealedRead) { throw new Error('отозвано'); } })).rejects.toThrow('отозвано');
        expect(await ids()).toEqual(['local-original']);
    });
    it.each([{name:'отзыв прав',error:new Error('late authorization revoked')},{name:'отмена',error:new DOMException('late cancellation','AbortError')}])(
        '$name после публикации prepared intent не начинает переключение рабочего индекса',async({error})=>{
            const link=fs.link,rename=fs.rename;let revoked=false,mutations=0,lateChecks=0;
            vi.spyOn(fs,'link').mockImplementation(async(...args)=>{const result=await link(...args);if(path.basename(path.dirname(String(args[1])))==='rag-restores')revoked=true;return result;});
            vi.spyOn(fs,'rename').mockImplementation(async(...args)=>{if(args[0]===store||args[1]===store)mutations++;return rename(...args);});
            await expect(restoreRagDb({projectKey:'test-project',project:fixture.root},fixture.root,async()=>{if(revoked){lateChecks++;throw error;}})).rejects.toBe(error);
            expect(lateChecks).toBe(1);expect(mutations).toBe(0);expect(await ids()).toEqual(['local-original']);
            expect((await fs.readdir(path.dirname(store))).filter(name=>name.startsWith('.neurocenter-rag-restore-'))).toEqual([]);
            await expect(fs.stat(path.join(store,'index.lock'))).rejects.toMatchObject({code:'ENOENT'});
        },
    );
    it('Свежий допуск после prepared journal видит прежний индекс и разрешает единственное переключение',async()=>{
        const link=fs.link;let journal:string|undefined,admissions=0;
        vi.spyOn(fs,'link').mockImplementation(async(...args)=>{const result=await link(...args);if(path.basename(path.dirname(String(args[1])))==='rag-restores')journal=String(args[1]);return result;});
        const result=JSON.parse(await restoreRagDb({projectKey:'test-project',project:fixture.root},fixture.root,async()=>{
            if(journal){admissions++;expect(JSON.parse(await fs.readFile(journal,'utf8')).state).toBe('prepared');expect(await ids()).toEqual(['local-original']);}
        }));
        expect(admissions).toBe(1);expect(result).toMatchObject({complete:true,written:1});expect(await ids()).toEqual(['server-row']);
        await expect(fs.stat(journal!)).rejects.toMatchObject({code:'ENOENT'});
    });
    it.each([false,true])('Ручные настройки, изменённые во время финального допуска (отзыв: %s), сохраняются без переключения и блокирующего журнала',async revoked=>{
        const settings=path.join(store,'runtime-overrides.json'),initial=JSON.stringify({retrieval:{topK:17}}),manual=JSON.stringify({retrieval:{topK:23}});
        await fs.writeFile(settings,initial);
        const link=fs.link;let journal:string|undefined,reached!:()=>void,release!:()=>void;
        const pending=new Promise<void>(resolve=>{reached=resolve;}),continueAdmission=new Promise<void>(resolve=>{release=resolve;});
        vi.spyOn(fs,'link').mockImplementation(async(...args)=>{const result=await link(...args);if(path.basename(path.dirname(String(args[1])))==='rag-restores')journal=String(args[1]);return result;});
        const denied=new Error('late authorization revoked after manual edit');
        const operation=restoreRagDb({projectKey:'test-project',project:fixture.root},fixture.root,async()=>{
            if(journal){reached();await continueAdmission;if(revoked)throw denied;}
        }).then(result=>({result,error:undefined}),error=>({result:undefined,error: error as Error}));
        await pending;
        try{await fs.writeFile(settings,manual);}finally{release();}
        const outcome=await operation;
        expect(await ids()).toEqual(['local-original']);
        expect(await fs.readFile(settings,'utf8')).toBe(manual);
        if(revoked)expect(outcome.error).toBe(denied);else expect(outcome.error?.message).toContain('Индекс изменился перед переключением');
        expect(outcome.result).toBeUndefined();
        await expect(fs.stat(journal!)).rejects.toMatchObject({code:'ENOENT'});
        await expect(fs.stat(path.join(store,'index.lock'))).rejects.toMatchObject({code:'ENOENT'});
        expect((await fs.readdir(path.dirname(store))).filter(name=>name.startsWith('.neurocenter-rag-restore-'))).toEqual([]);
        await locateStore(fixture.root,fixture.root);
        expect(JSON.parse(await run())).toMatchObject({complete:true,written:1});
        expect(await ids()).toEqual(['server-row']);expect(await fs.readFile(settings,'utf8')).toBe(manual);
    });
    it('Recovery aborted журнала после отказа очистки сохраняет позднюю ручную правку без повторного скачивания',async()=>{
        const settings=path.join(store,'runtime-overrides.json'),manual=JSON.stringify({retrieval:{topK:29}});
        await fs.writeFile(settings,JSON.stringify({retrieval:{topK:17}}));
        const link=fs.link,remove=fs.rm,cleanup=new Error('staging cleanup temporarily unavailable');
        let journal:string|undefined,stage:string|undefined;
        vi.spyOn(fs,'link').mockImplementation(async(...args)=>{const result=await link(...args);if(path.basename(path.dirname(String(args[1])))==='rag-restores'){journal=String(args[1]);stage=JSON.parse(await fs.readFile(journal,'utf8')).stage;}return result;});
        const failure=vi.spyOn(fs,'rm').mockImplementation(async(...args)=>{if(args[0]===stage)throw cleanup;return remove(...args);});
        await expect(restoreRagDb({projectKey:'test-project',project:fixture.root},fixture.root,async()=>{
            if(journal)await fs.writeFile(settings,manual);
        })).rejects.toSatisfy((error:unknown)=>error instanceof Error&&error.cause instanceof Error&&error.cause.message.includes('Индекс изменился перед переключением')&&'recoveryCause'in error&&error.recoveryCause===cleanup&&'restoreRecoveryPending'in error&&error.restoreRecoveryPending===true);
        expect(await ids()).toEqual(['local-original']);expect(await fs.readFile(settings,'utf8')).toBe(manual);
        expect(JSON.parse(await fs.readFile(journal!,'utf8')).state).toBe('aborted');
        failure.mockRestore();transport.fetch.mockClear();
        await locateStore(fixture.root,fixture.root);await locateStore(fixture.root,fixture.root);
        expect(transport.fetch).not.toHaveBeenCalled();expect(await ids()).toEqual(['local-original']);expect(await fs.readFile(settings,'utf8')).toBe(manual);
        await expect(fs.stat(journal!)).rejects.toMatchObject({code:'ENOENT'});await expect(fs.stat(stage!)).rejects.toMatchObject({code:'ENOENT'});
        expect(JSON.parse(await run())).toMatchObject({complete:true,written:1});expect(await fs.readFile(settings,'utf8')).toBe(manual);
    });
    it('Отказ очистки aborted intent сохраняет исходную причину и восстанавливается без повторного скачивания',async()=>{
        const primary=Error('revoked before switch'),cleanup=Object.assign(Error('staging cleanup unavailable'),{code:'EACCES'}),link=fs.link,remove=fs.rm;
        let journal:string|undefined,stage:string|undefined;
        vi.spyOn(fs,'link').mockImplementation(async(...args)=>{const result=await link(...args);if(path.basename(path.dirname(String(args[1])))==='rag-restores'){journal=String(args[1]);stage=JSON.parse(await fs.readFile(journal,'utf8')).stage;}return result;});
        const failure=vi.spyOn(fs,'rm').mockImplementation(async(...args)=>{if(args[0]===stage)throw cleanup;return remove(...args);});
        await expect(restoreRagDb({projectKey:'test-project',project:fixture.root},fixture.root,async()=>{if(journal)throw primary;})).rejects.toSatisfy((error:unknown)=>error instanceof Error&&error.cause===primary&&'recoveryCause'in error&&error.recoveryCause===cleanup&&'restoreRecoveryPending'in error&&error.restoreRecoveryPending===true);
        expect(await ids()).toEqual(['local-original']);expect(JSON.parse(await fs.readFile(journal!,'utf8')).state).toBe('aborted');await fs.stat(stage!);
        failure.mockRestore();transport.fetch.mockClear();await locateStore(fixture.root,fixture.root);
        expect(await ids()).toEqual(['local-original']);expect(transport.fetch).not.toHaveBeenCalled();await expect(fs.stat(journal!)).rejects.toMatchObject({code:'ENOENT'});await expect(fs.stat(stage!)).rejects.toMatchObject({code:'ENOENT'});
    });
    it.each(['исходная папка','резервная папка появилась','исходная папка заменена','staging изменён'])('Recovery prepared после поздней ручной правки: %s',async scenario=>{
        const settings=path.join(store,'runtime-overrides.json'),manual=JSON.stringify({retrieval:{topK:37}});
        await fs.writeFile(settings,JSON.stringify({retrieval:{topK:17}}));
        const link=fs.link,rename=fs.rename;let journal:string|undefined,stage:string|undefined,backup:string|undefined;
        vi.spyOn(fs,'link').mockImplementation(async(...args)=>{const result=await link(...args);if(path.basename(path.dirname(String(args[1])))==='rag-restores'){journal=String(args[1]);const intent=JSON.parse(await fs.readFile(journal,'utf8'));stage=intent.stage;backup=intent.backup;}return result;});
        const failedAbort=new Error('interrupted before aborted state became durable');
        const failure=vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{
            if(to===journal&&JSON.parse(await fs.readFile(from,'utf8')).state==='aborted')throw failedAbort;
            return rename(from,to);
        });
        await expect(restoreRagDb({projectKey:'test-project',project:fixture.root},fixture.root,async()=>{
            if(journal){await fs.writeFile(settings,manual);await fs.writeFile(path.join(store,'manual.txt'),'Сохранить ручной файл');}
        })).rejects.toMatchObject({restoreRecoveryPending:true,recoveryCause:failedAbort});
        failure.mockRestore();
        expect(JSON.parse(await fs.readFile(journal!,'utf8')).state).toBe('prepared');
        if(scenario==='резервная папка появилась'){await fs.mkdir(backup!);await fs.writeFile(path.join(backup!,'manual.txt'),'Чужая резервная папка');}
        if(scenario==='исходная папка заменена'){const previous=store+'-manual';await fs.rename(store,previous);await fs.cp(previous,store,{recursive:true});}
        if(scenario==='staging изменён')await fs.writeFile(path.join(stage!,'manual.txt'),'Чужой файл staging');
        transport.fetch.mockClear();
        if(scenario==='исходная папка'){
            await locateStore(fixture.root,fixture.root);await locateStore(fixture.root,fixture.root);
            await expect(fs.stat(journal!)).rejects.toMatchObject({code:'ENOENT'});await expect(fs.stat(stage!)).rejects.toMatchObject({code:'ENOENT'});
            expect(await ids()).toEqual(['local-original']);expect(await fs.readFile(path.join(store,'manual.txt'),'utf8')).toBe('Сохранить ручной файл');
            expect(await fs.readFile(settings,'utf8')).toBe(manual);expect(transport.fetch).not.toHaveBeenCalled();
            expect(JSON.parse(await run())).toMatchObject({complete:true,written:1});
        }else{
            await expect(locateStore(fixture.root,fixture.root)).rejects.toThrow(scenario==='staging изменён'?'Файлы резервной папки изменились':'Положение исходного индекса неоднозначно');
            await fs.stat(journal!);await fs.stat(stage!);
            if(scenario==='резервная папка появилась')expect(await fs.readFile(path.join(backup!,'manual.txt'),'utf8')).toBe('Чужая резервная папка');
            if(scenario==='staging изменён')expect(await fs.readFile(path.join(stage!,'manual.txt'),'utf8')).toBe('Чужой файл staging');
            expect(transport.fetch).not.toHaveBeenCalled();
        }
        expect(await ids()).toEqual([scenario==='исходная папка'?'server-row':'local-original']);
        expect(await fs.readFile(settings,'utf8')).toBe(manual);
        if(scenario!=='исходная папка')expect(await fs.readFile(path.join(store,'manual.txt'),'utf8')).toBe('Сохранить ручной файл');
    });
});
