import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'jsonc-parser';
import { install } from '../src/bridge/installer.js';
import { hash, writeState } from '../src/bridge/state.js';
import { bindProject, setRoot } from '../src/bridge/workspace.js';
import { canonical, verify, type Package } from '../src/bridge/package.js';

function pack(
    kind = 'skill',
    version = 1,
    files = [{ path: 'SKILL.md', content: 'инструкция' }],
    config: Package['config'] = null,
): Package {
    const plugin = { id: 'common/test', name: 'test-skill', kind, version };
    const entries = files.map((file) => ({
        ...file,
        size: Buffer.byteLength(file.content),
        sha256: hash(file.content),
    }));
    const manifest = hash(
        JSON.stringify(
            canonical({
                schemaVersion: 2,
                plugin,
                config,
                files: entries
                    .map(({ path, size, sha256 }) => ({ path, size, sha256 }))
                    .sort((a, b) => a.path.localeCompare(b.path)),
            }),
        ),
    );
    return {
        schemaVersion: 2,
        plugin,
        config,
        files: entries,
        manifest: { sha256: manifest, filesCount: entries.length },
    };
}
describe('Локальная установка из очереди MCP', () => {
    let root: string;
    let folder: string;
    const authorize = vi.fn(async () => ({ ok: true }));
    const progress = vi.fn(async () => undefined);
    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-worker-'));
        vi.stubEnv('NEUROCENTER_BRIDGE_HOME', path.join(root, 'state'));
        vi.stubEnv('NEUROCENTER_URL', 'http://localhost:5173');
        folder = path.join(root, 'проекты', 'другое имя');
        await fs.mkdir(folder, { recursive: true });
        await setRoot(path.dirname(folder));
        await bindProject('prj-test', 'другое имя');
        authorize.mockClear();
        progress.mockClear();
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        await fs.rm(root, { recursive: true, force: true });
    });
    it('Ставит файл по явному ID независимо от названия папки и повторяется без дублей', async () => {
        const first = await install('prj-test', pack(), authorize, progress);
        const second = await install('prj-test', pack(), authorize, progress);
        expect(first.changed).toBe(true);
        expect(second.changed).toBe(false);
        expect(
            await fs.readFile(
                path.join(folder, '.opencode/skills/test-skill/SKILL.md'),
                'utf8',
            ),
        ).toBe('инструкция');
        expect(authorize).toHaveBeenCalledTimes(2);
    });
    it('Не перезаписывает ручные изменения при обновлении', async () => {
        await install('prj-test', pack(), authorize, progress);
        const file = path.join(folder, '.opencode/skills/test-skill/SKILL.md');
        await fs.writeFile(file, 'моя правка');
        await expect(
            install('prj-test', pack('skill', 2), authorize, progress),
        ).rejects.toThrow('вручную');
        expect(await fs.readFile(file, 'utf8')).toBe('моя правка');
    });
    it('Повреждённый пакет не создаёт ни файлов, ни квитанции', async () => {
        const pkg = pack();
        pkg.files[0]!.content = 'подмена';
        await expect(
            install('prj-test', pkg, authorize, progress),
        ).rejects.toThrow('Повреждён');
        expect(authorize).not.toHaveBeenCalled();
        await expect(
            fs.access(path.join(folder, '.opencode/skills')),
        ).rejects.toThrow();
    });
    it.each([
        '../outside',
        'C:/outside',
        'A/../outside',
        'name\\outside',
        'CON.txt',
        'same/FILE.',
    ])('Отклоняет непереносимый путь %s', async (file) => {
        expect(() =>
            verify(
                pack('mcp', 1, [{ path: file, content: 'x' }], {
                    command: 'node',
                }),
            ),
        ).toThrow();
    });
    it('Симлинк не позволяет записать за пределами проекта', async () => {
        await fs.symlink(root, path.join(folder, '.opencode/skills'));
        await expect(
            install('prj-test', pack(), authorize, progress),
        ).rejects.toThrow('симлинк');
    });
    it('Отзыв доступа до записи оставляет проект без нового файла', async () => {
        await expect(
            install(
                'prj-test',
                pack(),
                async () => {
                    throw new Error('Доступ отозван');
                },
                progress,
            ),
        ).rejects.toThrow('отозван');
        await expect(
            fs.access(path.join(folder, '.opencode/skills')),
        ).rejects.toThrow();
    });
    it('Сохраняет JSONC, чужой MCP и точные аргументы с пробелами', async () => {
        const config = path.join(folder, 'opencode.jsonc');
        await fs.writeFile(
            config,
            '// Команда\n{"model":"local/test","mcp":{"other":{"type":"remote","url":"https://example.test/mcp"}}}',
        );
        await install(
            'prj-test',
            pack(
                'mcp',
                1,
                [{ path: 'server.mjs', content: 'console.log(1)' }],
                {
                    transport: 'stdio',
                    command: 'node',
                    entrypoint: 'server.mjs',
                    args: ['два слова', '--name=a b'],
                    env: { KEY: '{env:KEY}' },
                },
            ),
            authorize,
            progress,
        );
        const text = await fs.readFile(config, 'utf8');
        const result = parse(text);
        expect(text).toContain('// Команда');
        expect(result.model).toBe('local/test');
        expect(result.mcp.other.url).toBe('https://example.test/mcp');
        const installed = Object.entries(result.mcp).find(([key]) =>
            key.startsWith('neurocenter_'),
        )![1] as { command: string[]; environment: Record<string, string> };
        expect(installed.command.slice(-2)).toEqual([
            'два слова',
            '--name=a b',
        ]);
        expect(installed.environment.KEY).toBe('{env:KEY}');
    });
    it('Новая версия убирает только прежние управляемые файлы', async () => {
        await install(
            'prj-test',
            pack(
                'mcp',
                1,
                [
                    { path: 'old.mjs', content: 'x' },
                    { path: 'server.mjs', content: 'x' },
                ],
                { command: 'node', entrypoint: 'server.mjs' },
            ),
            authorize,
            progress,
        );
        await install(
            'prj-test',
            pack('mcp', 2, [{ path: 'server.mjs', content: 'y' }], {
                command: 'node',
                entrypoint: 'server.mjs',
            }),
            authorize,
            progress,
        );
        const key = hash('mcp:common/test').slice(0, 24);
        await expect(
            fs.access(
                path.join(folder, '.opencode/mcp-bundles', key, 'old.mjs'),
            ),
        ).rejects.toThrow();
    });
    it('Перепривязка к другому проекту не меняет исходный ID', async () => {
        await expect(bindProject('prj-other', 'другое имя')).rejects.toThrow(
            'другим проектом',
        );
        const binding = JSON.parse(
            await fs.readFile(
                path.join(folder, '.opencode/neurocenter.json'),
                'utf8',
            ),
        );
        expect(binding.projectId).toBe('prj-test');
    });
});
