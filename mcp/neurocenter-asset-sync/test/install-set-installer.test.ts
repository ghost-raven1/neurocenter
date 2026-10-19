import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { install, installSet } from '../src/bridge/installer.js';
import { uninstall } from '../src/bridge/uninstaller.js';
import { assetBase, assetKey, receiptPath } from '../src/bridge/installation-receipt.js';
import { LEDGER_PATH } from '../src/bridge/installation-ledger.js';
import { hash, jobContext, stateDir } from '../src/bridge/state.js';
import { pendingCompletions } from '../src/bridge/completions.js';
import { withProjectFiles } from '../src/bridge/installation-files.js';
import { rehashPackage, setFixture, setPackage } from './install-set-fixture.js';
import { workspaceFixture } from './bridge-fixture.js';

describe('Единая локальная транзакция графа инструментов', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    const authorize = vi.fn(async () => undefined);
    const progress = vi.fn(async () => undefined);
    const read = (relative: string) => fs.readFile(path.join(fixture.root, relative), 'utf8');
    const ledger = async () => JSON.parse(await read(LEDGER_PATH));
    beforeEach(async () => { fixture = await workspaceFixture(); authorize.mockClear(); progress.mockClear(); });
    afterEach(async () => {
        vi.restoreAllMocks(); vi.unstubAllEnvs();
        await fs.rm(fixture.temporary, { recursive: true, force: true });
    });
    it('Объединяет два MCP, плагин и скилл в один JSONC и один журнал', async () => {
        const a = setPackage('a'); const b = setPackage('b'); const plugin = setPackage('plugin', 'plugin');
        const root = setPackage('root', 'skill', 1, [a, b, plugin]);
        const set = setFixture(root, [a, b, plugin]);
        await fs.writeFile(path.join(fixture.root, 'opencode.jsonc'), '// Комментарий\n{"model":"user-model","mcp":{"personal":{"enabled":true}},"plugin":["personal-plugin"]}');
        const result = await installSet('test-project', set, authorize, progress);
        const text = await read('opencode.jsonc'); const config = parse(text);
        expect(text).toContain('// Комментарий'); expect(config.model).toBe('user-model');
        expect(Object.keys(config.mcp)).toHaveLength(3); expect(config.mcp.personal.enabled).toBe(true);
        expect(config.plugin).toHaveLength(2); expect(config.plugin).toContain('personal-plugin');
        expect(result.manifest).toBe(set.manifest); expect(result.packages).toHaveLength(4);
        expect(result.readiness).toBe('unverified'); expect(authorize).toHaveBeenCalledTimes(1);
        const directory = path.join(stateDir(), 'file-changes', hash(fixture.root), 'history');
        const history = await fs.readdir(directory); expect(history).toHaveLength(1);
        const journal = JSON.parse(await fs.readFile(path.join(directory, history[0]!), 'utf8'));
        expect(journal.changes.filter((item: {relative: string}) => item.relative === 'opencode.jsonc')).toHaveLength(1);
        expect(journal.manifest).toBe(set.manifest);
        expect((await installSet('test-project', set, authorize, progress)).changed).toBe(false);
        expect((await installSet('test-project', { ...set, packages: [...set.packages].reverse() }, authorize, progress)).changed).toBe(false);
    });
    it('Разделяет одинаковую зависимость и блокирует её обновление и удаление', async () => {
        const dep = setPackage('dep');
        const a = setPackage('root-a', 'skill', 1, [dep]); const b = setPackage('root-b', 'skill', 1, [dep]);
        await installSet('test-project', setFixture(a, [dep]), authorize, progress);
        await installSet('test-project', setFixture(b, [dep]), authorize, progress);
        expect(Object.keys((await ledger()).roots)).toHaveLength(2);
        await expect(install('test-project', setPackage('dep', 'mcp', 2), authorize, progress)).rejects.toThrow('закреплена другим');
        await expect(uninstall('test-project', dep, authorize, progress)).rejects.toThrow('используется как зависимость');
        const nextDep = setPackage('dep', 'mcp', 2);
        const nextA = setPackage('root-a', 'skill', 2, [nextDep]);
        await expect(installSet('test-project', setFixture(nextA, [nextDep]), authorize, progress)).rejects.toThrow('закреплена другим');
        expect(JSON.parse(await read(receiptPath(dep))).version).toBe(1);
    });
    it('Удаляет только root и сохраняет зависимости для явного удаления', async () => {
        const dep = setPackage('dep'); const root = setPackage('root', 'skill', 1, [dep]);
        await installSet('test-project', setFixture(root, [dep]), authorize, progress);
        await uninstall('test-project', root, authorize, progress);
        await expect(read(receiptPath(root))).rejects.toThrow();
        expect(await read(assetBase(dep) + '/index.mjs')).toContain('dep');
        expect((await ledger()).roots[assetKey(dep)].retained).toBe(true);
        await uninstall('test-project', dep, authorize, progress);
        await expect(read(receiptPath(dep))).rejects.toThrow();
    });
    it('После обновления root оставляет исчезнувшую зависимость самостоятельной', async () => {
        const dep = setPackage('dep'); const root = setPackage('root', 'skill', 1, [dep]);
        await installSet('test-project', setFixture(root, [dep]), authorize, progress);
        await install('test-project', setPackage('root', 'skill', 2), authorize, progress);
        expect((await ledger()).roots[assetKey(dep)].retained).toBe(true);
        await uninstall('test-project', dep, authorize, progress);
        expect(JSON.parse(await read(receiptPath(root))).version).toBe(2);
    });
    it.each(['удаления', 'обновления'])('После %s root сохраняет транзитивных владельцев retained-зависимости', async action => {
        const shared = setPackage('shared'); const dep = setPackage('dep', 'mcp', 1, [shared]);
        const root = setPackage('root', 'skill', 1, [dep]);
        await installSet('test-project', setFixture(root, [dep, shared]), authorize, progress);
        if (action === 'удаления') { await uninstall('test-project', root, authorize, progress); }
        else { await install('test-project', setPackage('root', 'skill', 2), authorize, progress); }
        const state = await ledger();
        expect(state.roots[assetKey(dep)].packages.map((item: {key: string}) => item.key)).toContain(assetKey(shared));
        await expect(uninstall('test-project', shared, authorize, progress)).rejects.toThrow('используется как зависимость');
        await expect(install('test-project', setPackage('shared', 'mcp', 2), authorize, progress)).rejects.toThrow('закреплена другим');
        await uninstall('test-project', dep, authorize, progress);
        await uninstall('test-project', shared, authorize, progress);
        await expect(read(receiptPath(shared))).rejects.toThrow();
    });
    it('Обновление не меняет shared-версию, ещё нужную исчезнувшему retained-пакету', async () => {
        const shared = setPackage('shared'); const dep = setPackage('dep', 'mcp', 1, [shared]);
        const root = setPackage('root', 'skill', 1, [dep]);
        await installSet('test-project', setFixture(root, [dep, shared]), authorize, progress);
        const nextShared = setPackage('shared', 'mcp', 2); const nextRoot = setPackage('root', 'skill', 2, [nextShared]);
        await expect(installSet('test-project', setFixture(nextRoot, [nextShared]), authorize, progress)).rejects.toThrow('закреплена другим');
        expect(JSON.parse(await read(receiptPath(shared))).version).toBe(1);
        expect(JSON.parse(await read(receiptPath(root))).version).toBe(1);
    });
    it('Мигрирует старую квитанцию в отдельное закрепление и не обновляет её чужим root', async () => {
        const dep = setPackage('dep'); await install('test-project', dep, authorize, progress);
        await fs.rm(path.join(fixture.root, LEDGER_PATH));
        const upgraded = setPackage('dep', 'mcp', 2);
        const root = setPackage('root', 'skill', 1, [upgraded]);
        await expect(installSet('test-project', setFixture(root, [upgraded]), authorize, progress)).rejects.toThrow('закреплена другим');
        const equalRoot = setPackage('root', 'skill', 1, [dep]);
        await installSet('test-project', setFixture(equalRoot, [dep]), authorize, progress);
        expect(Object.keys((await ledger()).roots)).toHaveLength(2);
    });
    it('Конфликт имён скиллов и ручная правка dependency блокируют весь набор', async () => {
        const dep = setPackage('dep'); const root = setPackage('root', 'skill', 1, [dep]);
        await installSet('test-project', setFixture(root, [dep]), authorize, progress);
        await fs.writeFile(path.join(fixture.root, assetBase(dep), 'index.mjs'), 'Моя правка');
        const next = setPackage('root', 'skill', 2, [dep]);
        await expect(installSet('test-project', setFixture(next, [dep]), authorize, progress)).rejects.toThrow('вручную');
        expect(JSON.parse(await read(receiptPath(root))).version).toBe(1);
        const other = setPackage('other', 'skill'); other.plugin.name = root.plugin.name; rehashPackage(other);
        await expect(install('test-project', other, authorize, progress)).rejects.toThrow('не управляется');
    });
    it('Отзыв доступа перед commit не записывает ни одного пакета или ledger', async () => {
        const dep = setPackage('dep'); const root = setPackage('root', 'skill', 1, [dep]);
        await expect(installSet('test-project', setFixture(root, [dep]), async () => { throw new Error('Роль отозвана'); }, progress)).rejects.toThrow('отозвана');
        await expect(read(receiptPath(dep))).rejects.toThrow(); await expect(read(LEDGER_PATH)).rejects.toThrow();
    });
    it('Повторно проверяет даже неизменяемую общую зависимость после авторизации', async () => {
        const dep = setPackage('dep'); const a = setPackage('a', 'skill', 1, [dep]);
        await installSet('test-project', setFixture(a, [dep]), authorize, progress);
        const b = setPackage('b', 'skill', 1, [dep]);
        await expect(installSet('test-project', setFixture(b, [dep]), async () => {
            await fs.writeFile(path.join(fixture.root, assetBase(dep), 'index.mjs'), 'Ручная правка при авторизации');
        }, progress)).rejects.toThrow('изменился во время подготовки');
        await expect(read(receiptPath(b))).rejects.toThrow();
        expect(await read(assetBase(dep) + '/index.mjs')).toBe('Ручная правка при авторизации');
    });
    it('Ошибка записи откатывает файлы всех пакетов, конфигурацию и ledger', async () => {
        const dep = setPackage('dep'); const root = setPackage('root', 'skill', 1, [dep]);
        const original = '// Пользователь\n{"model":"my-model"}\n';
        await fs.writeFile(path.join(fixture.root, 'opencode.jsonc'), original);
        const link = fs.link.bind(fs); let failed = false;
        vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
            if (!failed && String(to).endsWith('/receipts/' + assetKey(dep) + '.json')) { failed = true; throw new Error('Нет места на диске'); }
            return link(from, to);
        });
        await expect(installSet('test-project', setFixture(root, [dep]), authorize, progress)).rejects.toThrow('Нет места');
        expect(await read('opencode.jsonc')).toBe(original);
        await expect(read(receiptPath(root))).rejects.toThrow(); await expect(read(receiptPath(dep))).rejects.toThrow();
        await expect(read(LEDGER_PATH)).rejects.toThrow();
        await expect(read(assetBase(root) + '/SKILL.md')).rejects.toThrow(); await expect(read(assetBase(dep) + '/index.mjs')).rejects.toThrow();
    });
    it('Durable completion сохраняет SET manifest и полный список при единственной фиксации', async () => {
        const dep = setPackage('dep'); const root = setPackage('root', 'skill', 1, [dep]); const set = setFixture(root, [dep]);
        await jobContext.run({ id: '11111111-1111-1111-1111-111111111111', lease: '22222222-2222-2222-2222-222222222222' },
            () => installSet('test-project', set, authorize, progress));
        const completions = await pendingCompletions(); expect(completions).toHaveLength(1);
        expect(completions[0]!.result.manifest).toBe(set.manifest);
        expect(completions[0]!.result.packages).toHaveLength(2);
    });
    it('После настоящего SIGKILL восстанавливает весь набор и SET результат', async () => {
        const dep = setPackage('dep'); const root = setPackage('root', 'skill', 1, [dep]); const set = setFixture(root, [dep]);
        const target = path.join(fixture.root, assetBase(dep), 'index.mjs');
        const installer = pathToFileURL(path.resolve('src/bridge/installer.ts')).href;
        const state = pathToFileURL(path.resolve('src/bridge/state.ts')).href;
        const source = `import fs from 'node:fs/promises';import {installSet} from ${JSON.stringify(installer)};import {jobContext} from ${JSON.stringify(state)};const link=fs.link.bind(fs);fs.link=async(from,to)=>{await link(from,to);if(to===${JSON.stringify(target)})process.kill(process.pid,'SIGKILL');};await jobContext.run({id:'11111111-1111-1111-1111-111111111111',lease:'22222222-2222-2222-2222-222222222222'},()=>installSet('test-project',${JSON.stringify(set)},async()=>{},async()=>{}));`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
        const signal = await new Promise<string | null>((resolve, reject) => { child.on('error', reject); child.on('exit', (_code, signal) => resolve(signal)); });
        expect(signal, stderr).toBe('SIGKILL');
        await withProjectFiles('test-project', async () => undefined);
        await expect(read(receiptPath(root))).rejects.toThrow(); await expect(read(receiptPath(dep))).rejects.toThrow();
        await expect(read(assetBase(root) + '/SKILL.md')).rejects.toThrow(); await expect(read(assetBase(dep) + '/index.mjs')).rejects.toThrow();
        await expect(read(LEDGER_PATH)).rejects.toThrow();
        const completions = await pendingCompletions(); expect(completions).toHaveLength(1);
        expect(completions[0]!.state).toBe('failed'); expect(completions[0]!.result.manifest).toBe(set.manifest);
        expect(completions[0]!.result.packages).toHaveLength(2); expect(completions[0]!.result.rolledBack).toBe(true);
        expect((await installSet('test-project', set, authorize, progress)).changed).toBe(true);
    });
});
