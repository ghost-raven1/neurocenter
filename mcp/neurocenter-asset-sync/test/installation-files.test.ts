import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    commitChanges,
    readText,
    withProjectFiles,
} from '../src/bridge/installation-files.js';
import { install } from '../src/bridge/installer.js';
import { uninstall } from '../src/bridge/uninstaller.js';
import { assetBase, receiptPath } from '../src/bridge/installation-receipt.js';
import { hash, jobContext, stateDir } from '../src/bridge/state.js';
import { workspaceReport } from '../src/bridge/workspace.js';
import { packageFixture, workspaceFixture } from './bridge-fixture.js';

describe('Журнал локальной записи и восстановление MCP', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    const identity = {
        action: 'install' as const,
        assetKey: '1'.repeat(24),
        manifest: '2'.repeat(64),
    };
    const directory = () =>
        path.join(stateDir(), 'file-changes', hash(fixture.root));
    async function pending(state = 'prepared') {
        await fs.mkdir(directory(), { recursive: true });
        const journal = {
            ...identity,
            version: 1,
            root: fixture.root,
            id: randomUUID(),
            state,
            changes: [
                { relative: 'one.txt', before: 'до', after: 'после' },
                { relative: 'two.txt', before: null, after: 'новый' },
            ],
        };
        await fs.writeFile(
            path.join(directory(), 'pending.json'),
            JSON.stringify(journal),
        );
        return journal;
    }
    beforeEach(async () => {
        fixture = await workspaceFixture();
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await fs.rm(fixture.temporary, { recursive: true, force: true });
    });
    it('Лимиты и повтор путей проверяются до появления pending.json', async () => {
        await withProjectFiles('test-project', async root => {
            await expect(commitChanges(root, Array.from({ length: 513 }, (_, i) => ({ relative: `file-${i}`, before: null, after: '' })), identity)).rejects.toThrow('512');
            await expect(commitChanges(root, [{ relative: 'file', before: null, after: 'x'.repeat(32 * 1048576 + 1) }], identity)).rejects.toThrow('32 МБ');
            await expect(commitChanges(root, [{ relative: 'file', before: null, after: 'a' }, { relative: 'FILE', before: null, after: 'b' }], identity)).rejects.toThrow('Повтор пути');
            expect(await readText(path.join(directory(), 'pending.json'))).toBeNull();
            expect(await readText(path.join(root, 'file'))).toBeNull();
        });
    });
    it('Восстанавливает набор больше прежнего лимита 205 записей', async () => {
        const journal = await pending();
        journal.changes = Array.from({ length: 206 }, (_, i) => ({ relative: `file-${i}`, before: null, after: 'данные' }));
        await fs.writeFile(path.join(directory(), 'pending.json'), JSON.stringify(journal));
        await fs.writeFile(path.join(fixture.root, 'file-0'), 'данные');
        await withProjectFiles('test-project', async () => undefined);
        expect(await readText(path.join(fixture.root, 'file-0'))).toBeNull();
        expect(await readText(path.join(directory(), 'pending.json'))).toBeNull();
    });
    it('Недоставляемый большой результат отклоняется до файловой фиксации', async () => {
        await withProjectFiles('test-project', root => jobContext.run({ id: randomUUID(), lease: randomUUID() }, async () => {
            await expect(commitChanges(root, [{ relative: 'file', before: null, after: 'данные' }], {
                ...identity, result: { projectId: 'test-project', packages: 'x'.repeat(10000) },
            })).rejects.toThrow('слишком велик');
        }));
        expect(await readText(path.join(directory(), 'pending.json'))).toBeNull();
        expect(await readText(path.join(fixture.root, 'file'))).toBeNull();
    });
    it('Откатывает частично записанный набор перед следующей операцией', async () => {
        const journal = await pending();
        await fs.writeFile(path.join(fixture.root, 'one.txt'), 'после');
        await withProjectFiles('test-project', async () => {
            expect(await readText(path.join(fixture.root, 'one.txt'))).toBe(
                'до',
            );
            expect(
                await readText(path.join(fixture.root, 'two.txt')),
            ).toBeNull();
        });
        expect(
            await readText(path.join(directory(), 'pending.json')),
        ).toBeNull();
        expect(
            JSON.parse(
                await fs.readFile(
                    path.join(directory(), 'history', journal.id + '.json'),
                    'utf8',
                ),
            ).state,
        ).toBe('rolled-back');
    });
    it('Не откатывает полностью зафиксированный набор после обрыва перед архивированием', async () => {
        const journal = await pending('committed');
        await fs.writeFile(path.join(fixture.root, 'one.txt'), 'после');
        await fs.writeFile(path.join(fixture.root, 'two.txt'), 'новый');
        await withProjectFiles('test-project', async () => undefined);
        expect(await readText(path.join(fixture.root, 'one.txt'))).toBe(
            'после',
        );
        expect(
            await readText(
                path.join(directory(), 'history', journal.id + '.json'),
            ),
        ).not.toBeNull();
    });
    it('Внешняя правка после обрыва блокирует весь автоматический откат', async () => {
        await pending();
        await fs.writeFile(path.join(fixture.root, 'one.txt'), 'после');
        await fs.writeFile(path.join(fixture.root, 'two.txt'), 'моя правка');
        await expect(
            withProjectFiles('test-project', async () => undefined),
        ).rejects.toThrow('Автоматический откат остановлен');
        expect(await readText(path.join(fixture.root, 'one.txt'))).toBe(
            'после',
        );
        expect(await readText(path.join(fixture.root, 'two.txt'))).toBe(
            'моя правка',
        );
        expect(
            await readText(path.join(directory(), 'pending.json')),
        ).not.toBeNull();
    });
    it('Сравнение перед записью сохраняет изменение, сделанное после проверки пакета', async () => {
        await fs.writeFile(path.join(fixture.root, 'one.txt'), 'моя правка');
        await expect(
            withProjectFiles('test-project', (root) =>
                commitChanges(
                    root,
                    [{ relative: 'one.txt', before: 'до', after: 'после' }],
                    identity,
                ),
            ),
        ).rejects.toThrow('откат остановлен');
        expect(await readText(path.join(fixture.root, 'one.txt'))).toBe(
            'моя правка',
        );
    });
    it('Вторая операция в том же проекте не обходит живой lock', async () => {
        await withProjectFiles('test-project', async () => {
            await expect(
                withProjectFiles('test-project', async () => undefined),
            ).rejects.toThrow('уже выполняется');
        });
        await expect(
            withProjectFiles('test-project', async () => true),
        ).resolves.toBe(true);
    });
    it('Запись конфигурации сохраняет её закрытые права доступа', async () => {
        const file = path.join(fixture.root, 'opencode.json');
        await fs.writeFile(file, '{}', { mode: 0o600 });
        await withProjectFiles('test-project', (root) =>
            commitChanges(
                root,
                [
                    {
                        relative: 'opencode.json',
                        before: '{}',
                        after: '{"model":"local"}',
                    },
                ],
                identity,
            ),
        );
        if (process.platform !== 'win32') {
            expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
        }
    });
    it('Симлинк вместо файла в журнале не допускает восстановления за пределами проекта', async () => {
        await pending();
        await fs.writeFile(
            path.join(fixture.temporary, 'outside.txt'),
            'мой файл',
        );
        await fs.symlink(
            path.join(fixture.temporary, 'outside.txt'),
            path.join(fixture.root, 'one.txt'),
        );
        await expect(
            withProjectFiles('test-project', async () => undefined),
        ).rejects.toThrow('симлинк');
        expect(
            await fs.readFile(
                path.join(fixture.temporary, 'outside.txt'),
                'utf8',
            ),
        ).toBe('мой файл');
    });
    it('После настоящего SIGKILL удаление восстанавливает незавершённую запись и повторяется', async () => {
        const pkg = packageFixture('mcp');
        await install(
            'test-project',
            pkg,
            async () => undefined,
            async () => undefined,
        );
        const target = path.join(
            fixture.root,
            assetBase(pkg),
            pkg.files[0].path,
        );
        const module = pathToFileURL(
            path.resolve('src/bridge/uninstaller.ts'),
        ).href;
        const source = `import fs from 'node:fs/promises'; import {uninstall} from ${JSON.stringify(module)}; const remove=fs.rm.bind(fs); fs.rm=async function(file,options){await remove(file,options);if(file===${JSON.stringify(target)}){process.kill(process.pid,'SIGKILL');}};await uninstall('test-project',${JSON.stringify(pkg)},async()=>undefined,async()=>undefined);`;
        const child = spawn(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '-e', source],
            { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let error = '';
        child.stderr.on('data', (data) => {
            error += data;
        });
        const exit = await new Promise<{
            code: number | null;
            signal: string | null;
        }>((resolve, reject) => {
            child.on('error', reject);
            child.on('exit', (code, signal) => resolve({ code, signal }));
        });
        expect(exit.signal, error).toBe('SIGKILL');
        expect(
            await readText(path.join(directory(), 'pending.json')),
        ).not.toBeNull();
        expect(await readText(target)).toBeNull();
        const result = await uninstall(
            'test-project',
            pkg,
            async () => undefined,
            async () => undefined,
        );
        expect(result.changed).toBe(true);
        expect(
            await readText(path.join(fixture.root, receiptPath(pkg))),
        ).toBeNull();
        expect(
            await readText(path.join(directory(), 'pending.json')),
        ).toBeNull();
    }, 15000);
    it('Недоступная общая папка не блокирует heartbeat и выбор нового пути', async () => {
        await fs.rename(
            path.dirname(fixture.root),
            path.join(fixture.temporary, 'перемещено'),
        );
        const report = await workspaceReport();
        expect(report.rootError).toContain('недоступна');
        expect(report.folders).toEqual([]);
        expect(report.bindings).toHaveLength(1);
    });
});
