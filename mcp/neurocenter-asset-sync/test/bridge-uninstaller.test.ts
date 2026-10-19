import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { install } from '../src/bridge/installer.js';
import { uninstall } from '../src/bridge/uninstaller.js';
import { assetBase, assetKey, receiptPath } from '../src/bridge/installation-receipt.js';
import { readText } from '../src/bridge/installation-files.js';
import { writeState } from '../src/bridge/state.js';
import { packageFixture, workspaceFixture } from './bridge-fixture.js';

describe('Безопасное удаление локального инструмента через MCP', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    const authorize = vi.fn(async () => undefined);
    const progress = vi.fn(async () => undefined);
    beforeEach(async () => {
        fixture = await workspaceFixture();
        authorize.mockClear();
        progress.mockClear();
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await fs.rm(fixture.temporary, { recursive: true, force: true });
    });
    it.each(['skill', 'mcp', 'plugin'])(
        'Удаляет управляемые файлы %s, сохраняет соседние и личную резервную копию',
        async (kind) => {
            const pkg = packageFixture(kind);
            await install('test-project', pkg, authorize, progress);
            const base = path.join(fixture.root, assetBase(pkg));
            await fs.writeFile(path.join(base, 'моя заметка.txt'), 'Не удалять');
            const result = await uninstall('test-project', pkg, authorize, progress);
            expect(result.changed).toBe(true);
            expect(result.files).toBe(1);
            expect(await readText(path.join(base, pkg.files[0].path))).toBeNull();
            expect(await readText(path.join(fixture.root, receiptPath(pkg)))).toBeNull();
            expect(await readText(path.join(base, 'моя заметка.txt'))).toBe('Не удалять');
            const backup = JSON.parse(await fs.readFile(result.recoveryPath, 'utf8'));
            expect(backup.changes[0].encoding === 'base64' ? Buffer.from(backup.changes[0].before, 'base64').toString('utf8') : backup.changes[0].before).toBe(pkg.files[0].content);
            expect(result.recoveryPath.startsWith(fixture.temporary + '/private/')).toBe(true);
            if (process.platform !== 'win32') {
                expect((await fs.stat(result.recoveryPath)).mode & 0o777).toBe(0o600);
            }
            const repeat = await uninstall('test-project', pkg, authorize, progress);
            expect(repeat.changed).toBe(false);
            expect(repeat.recoveryPath).toBe(result.recoveryPath);
        },
    );
    it('Сохраняет комментарии, модель и чужие подключения JSONC', async () => {
        const file = path.join(fixture.root, 'opencode.jsonc');
        await fs.writeFile(
            file,
            '// Моя конфигурация\n{"model":"local/test","mcp":{"personal":{"type":"remote","url":"https://example.test/mcp"}},"plugin":["personal-plugin"]}',
        );
        for (const kind of ['mcp', 'plugin']) {
            const pkg = packageFixture(kind);
            await install('test-project', pkg, authorize, progress);
            await uninstall('test-project', pkg, authorize, progress);
        }
        const result = await fs.readFile(file, 'utf8');
        expect(result).toContain('// Моя конфигурация');
        expect(parse(result)).toEqual({
            model: 'local/test',
            mcp: {
                personal: { type: 'remote', url: 'https://example.test/mcp' },
            },
            plugin: ['personal-plugin'],
        });
    });
    it('Ручная правка любого файла останавливает удаление целиком', async () => {
        const pkg = packageFixture('mcp');
        await install('test-project', pkg, authorize, progress);
        const file = path.join(fixture.root, assetBase(pkg), pkg.files[0].path);
        await fs.writeFile(file, 'Мои изменения');
        const config = await fs.readFile(path.join(fixture.root, 'opencode.json'), 'utf8');
        await expect(uninstall('test-project', pkg, authorize, progress)).rejects.toThrow(
            'вручную',
        );
        expect(await fs.readFile(file, 'utf8')).toBe('Мои изменения');
        expect(await readText(path.join(fixture.root, receiptPath(pkg)))).not.toBeNull();
        expect(await fs.readFile(path.join(fixture.root, 'opencode.json'), 'utf8')).toBe(config);
    });
    it('Ручная правка управляемого подключения MCP сохраняет и конфигурацию, и пакет', async () => {
        const pkg = packageFixture('mcp');
        await install('test-project', pkg, authorize, progress);
        const file = path.join(fixture.root, 'opencode.json');
        const config = JSON.parse(await fs.readFile(file, 'utf8'));
        config.mcp['neurocenter_' + assetKey(pkg)].enabled = false;
        await fs.writeFile(file, JSON.stringify(config));
        await expect(uninstall('test-project', pkg, authorize, progress)).rejects.toThrow(
            'вручную',
        );
        expect(await readText(path.join(fixture.root, assetBase(pkg), pkg.files[0].path))).toBe(
            pkg.files[0].content,
        );
        expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(config);
    });
    it.each(['mcp', 'plugin'])(
        'Невалидный JSONC перед удалением %s не меняет файлы',
        async (kind) => {
            const pkg = packageFixture(kind);
            await install('test-project', pkg, authorize, progress);
            await fs.writeFile(path.join(fixture.root, 'opencode.json'), '{broken');
            await expect(uninstall('test-project', pkg, authorize, progress)).rejects.toThrow(
                'JSON/JSONC',
            );
            expect(await readText(path.join(fixture.root, assetBase(pkg), pkg.files[0].path))).toBe(
                pkg.files[0].content,
            );
        },
    );
    it('Смена точки входа плагина внутри пакета сохраняет файлы и подключение', async () => {
        const pkg = packageFixture('plugin');
        await install('test-project', pkg, authorize, progress);
        const file = path.join(fixture.root, 'opencode.json');
        const config = JSON.parse(await fs.readFile(file, 'utf8'));
        config.plugin[0] = config.plugin[0].replace('/index.mjs', '/другой.mjs');
        await fs.writeFile(file, JSON.stringify(config));
        await expect(uninstall('test-project', pkg, authorize, progress)).rejects.toThrow(
            'Путь плагина изменён вручную',
        );
        expect(await readText(path.join(fixture.root, assetBase(pkg), pkg.files[0].path))).toBe(
            pkg.files[0].content,
        );
        expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(config);
    });
    it('Уже отсутствующие файл и конфигурация не мешают убрать квитанцию', async () => {
        const pkg = packageFixture('mcp');
        await install('test-project', pkg, authorize, progress);
        await fs.rm(path.join(fixture.root, assetBase(pkg), pkg.files[0].path));
        await fs.rm(path.join(fixture.root, 'opencode.json'));
        expect((await uninstall('test-project', pkg, authorize, progress)).files).toBe(0);
        expect(await readText(path.join(fixture.root, receiptPath(pkg)))).toBeNull();
    });
    it('Старая команда удаления не затрагивает обновлённый пакет', async () => {
        await install('test-project', packageFixture(), authorize, progress);
        const updated = packageFixture('skill', 2);
        await install('test-project', updated, authorize, progress);
        await expect(
            uninstall('test-project', packageFixture(), authorize, progress),
        ).rejects.toThrow('другая версия');
        expect(
            await readText(path.join(fixture.root, assetBase(updated), updated.files[0].path)),
        ).toBe(updated.files[0].content);
    });
    it('Поддельный список файлов в квитанции не разрешает удалить соседний файл', async () => {
        const pkg = packageFixture();
        await install('test-project', pkg, authorize, progress);
        const file = path.join(fixture.root, receiptPath(pkg));
        const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
        receipt.files['../соседний.txt'] = '0'.repeat(64);
        await fs.writeFile(file, JSON.stringify(receipt));
        await expect(uninstall('test-project', pkg, authorize, progress)).rejects.toThrow(
            'Квитанция',
        );
        expect(await readText(path.join(fixture.root, assetBase(pkg), pkg.files[0].path))).toBe(
            pkg.files[0].content,
        );
    });
    it('Отсутствующая квитанция без личной записи удаления не даёт менять файлы', async () => {
        await expect(
            uninstall('test-project', packageFixture(), authorize, progress),
        ).rejects.toThrow('Квитанция отсутствует');
    });
    it('Отзыв роли перед записью сохраняет установку', async () => {
        const pkg = packageFixture();
        await install('test-project', pkg, authorize, progress);
        await expect(
            uninstall(
                'test-project',
                pkg,
                async () => {
                    throw new Error('Доступ отозван');
                },
                progress,
            ),
        ).rejects.toThrow('отозван');
        expect(await readText(path.join(fixture.root, receiptPath(pkg)))).not.toBeNull();
    });
    it('Смена привязки во время проверки останавливает запись', async () => {
        const pkg = packageFixture();
        await install('test-project', pkg, authorize, progress);
        await expect(
            uninstall(
                'test-project',
                pkg,
                async () => {
                    await writeState('workspace', {
                        root: fixture.root,
                        bindings: {},
                    });
                },
                progress,
            ),
        ).rejects.toThrow('Свяжите');
        expect(await readText(path.join(fixture.root, receiptPath(pkg)))).not.toBeNull();
    });
});
