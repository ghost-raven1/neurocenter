import { describe, expect, it } from 'vitest';
import { packagingEntrypoints, readPackagingFiles } from '../src/modules/Store/packaging/sourceFiles';
import type { PackagingInputFile } from '../src/modules/Store/packaging/sourceFiles';
import { isSourceEntrypoint } from '../../services/shared/source-entrypoint.cjs';

function file(relative: string, content = 'export default () => ({});', overrides: Partial<PackagingInputFile> = {}): PackagingInputFile {
    const bytes = new TextEncoder().encode(content);
    return { name: relative.split('/').pop()!, webkitRelativePath: relative, size: bytes.byteLength,
        arrayBuffer: async () => bytes.buffer, ...overrides };
}

describe('Исходники автономного инструмента', () => {
    it('Убирает корень выбранной папки, сохраняет вложенность и пропускает зависимости с секретами', async () => {
        const result = await readPackagingFiles([file('plugin/src/index.ts'), file('plugin/package.json', '{}'),
            file('plugin/node_modules/lib/index.js'), file('plugin/.git/config'), file('plugin/.env.local'),
            file('plugin/certs/private.pem'), file('plugin/id_ed25519')]);
        expect(result.rootName).toBe('plugin');
        expect(result.files.map(item => item.path)).toEqual(['src/index.ts', 'package.json']);
        expect(result.skipped).toBe(5);
    });
    it.each(['/absolute.js', '../escape.js', 'project/../../escape.js', 'C:\\temp\\plugin.js', 'project/bad\nname.js', 'project/nul.js'])('Не принимает непереносимый путь %s', async relative => {
        await expect(readPackagingFiles([file(relative)])).rejects.toThrow('непереносимый путь');
    });
    it('Не допускает дубль на файловой системе без учёта регистра', async () => {
        await expect(readPackagingFiles([file('plugin/Index.ts'), file('plugin/index.ts')])).rejects.toThrow('повторяется');
    });
    it('Отклоняет бинарный файл и повреждённый UTF-8', async () => {
        await expect(readPackagingFiles([file('plugin/index.js', 'text\0binary')])).rejects.toThrow('UTF-8');
        await expect(readPackagingFiles([file('plugin/index.js', '', { arrayBuffer: async () => new Uint8Array([0xff, 0xfe, 0xff]).buffer })])).rejects.toThrow('UTF-8');
    });
    it('Проверяет лимиты до чтения тяжёлого файла', async () => {
        let reads = 0;
        await expect(readPackagingFiles([file('plugin/index.js', '', { size: 1024 * 1024 + 1, arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } })])).rejects.toThrow('до 1 МБ');
        expect(reads).toBe(0);
        await expect(readPackagingFiles(Array.from({ length: 101 }, (_, index) => file(`plugin/${index}.js`)))).rejects.toThrow('до 100');
        await expect(readPackagingFiles(Array.from({ length: 6 }, (_, index) => file(`plugin/${index}.js`, '', { size: 1024 * 1024 })))).rejects.toThrow('до 5 МБ');
    });
    it('Не отправляет пустую папку после фильтрации', async () => {
        await expect(readPackagingFiles([file('project/.env'), file('project/node_modules/index.js')])).rejects.toThrow('нет подходящих');
    });
    it('Пропускает macOS-метаданные и конфиги registry до чтения бинарных данных и секретов', async () => {
        const binary = { arrayBuffer: async () => new Uint8Array([0, 255]).buffer };
        const result = await readPackagingFiles([file('tool/index.ts'), file('tool/.DS_Store', '', binary),
            file('tool/._index.ts', '', binary), file('tool/__MACOSX/metadata', '', binary),
            file('tool/.npmrc', 'fixture-token'), file('tool/.yarnrc', 'fixture-token'), file('tool/.yarnrc.yml', 'fixture-token'),
            file('tool/.GIT/config'), file('tool/NODE_MODULES/unused.js')]);
        expect(result.files.map(item => item.path)).toEqual(['index.ts']);
        expect(result.skipped).toBe(8);
    });
    it('Сохраняет исходное Unicode-имя файла, отклоняя эквивалентные NFC-дубли', async () => {
        const decomposed = 'cafe\u0301.ts';
        expect((await readPackagingFiles([file('tool/' + decomposed)])).files[0].path).toBe(decomposed);
        await expect(readPackagingFiles([file('tool/café.ts'), file('tool/' + decomposed)])).rejects.toThrow('повторяется');
    });
    it.each(['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'tsx'])('Предлагает исполняемый .%s в соответствии с серверным контрактом', extension => {
        const entrypoint = `server.${extension}`;
        expect(isSourceEntrypoint(entrypoint)).toBe(true);
        expect(packagingEntrypoints([{path: entrypoint, content: 'fixture'}], 'mcp')).toEqual([entrypoint]);
    });
    it.each(['server.d.ts', 'server.d.mts', 'server.d.cts', 'README.md', 'index.json', 'index.jsx'])('Не предлагает декларации и неподдерживаемые entrypoint: %s', entrypoint => {
        expect(isSourceEntrypoint(entrypoint)).toBe(false);
        expect(packagingEntrypoints([{path: 'package.json', content: JSON.stringify({bin: entrypoint, main: entrypoint})},
            {path: entrypoint, content: 'fixture'}], 'mcp')).toEqual([]);
    });
    it('Для MCP предпочитает bin, для плагина main; отсутствующие и посторонние типы исключает', () => {
        const files = [{ path: 'package.json', content: JSON.stringify({ bin: { cli: './src/cli.ts' }, main: './index.js', module: 'missing.js' }) },
            { path: 'index.js', content: 'export default 1' }, { path: 'src/cli.ts', content: '' }, { path: 'README.md', content: '' }];
        expect(packagingEntrypoints(files, 'mcp')).toEqual(['src/cli.ts', 'index.js']);
        expect(packagingEntrypoints(files, 'plugin')).toEqual(['index.js', 'src/cli.ts']);
    });
    it('При ошибке package.json позволяет явно выбрать существующий файл', () => {
        expect(packagingEntrypoints([{ path: 'package.json', content: '{broken' }, { path: 'start.mjs', content: '' }], 'mcp')).toEqual(['start.mjs']);
    });
    it('Не падает из-за постороннего значения bin в package.json', () => {
        expect(packagingEntrypoints([{ path: 'package.json', content: '{"bin":{"cli":42}}' }, { path: 'index.js', content: '' }], 'mcp')).toEqual(['index.js']);
    });
});
