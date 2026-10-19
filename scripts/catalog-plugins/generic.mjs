import fs from 'node:fs/promises';
import path from 'node:path';
import { installDependencies } from './recipes/upstream.mjs';

export const npmTools = [
    { key: 'filesystem', name: 'MCP Filesystem', package: '@modelcontextprotocol/server-filesystem', version: '1.0.0',
        description: 'Чтение, поиск и редактирование файлов только в папке выбранного проекта. Готовый npm-комплект с зависимостями; мост запускает его своим Node без npm на компьютере.', tags: ['Файлы', 'npm', 'Готовый комплект'] },
    { key: 'memory', name: 'MCP Memory', package: '@modelcontextprotocol/server-memory', version: '1.0.0',
        description: 'Локальный граф памяти: сущности, связи и наблюдения между сессиями агента. Данные хранятся в .opencode/neurocenter-memory проекта. Готовый npm-комплект без облака и API-ключей.', tags: ['Память', 'npm', 'Готовый комплект'] },
    { key: 'sequential-thinking', name: 'MCP Sequential Thinking', package: '@modelcontextprotocol/server-sequential-thinking', version: '1.0.0',
        description: 'Пошаговое рассуждение для сложных задач: пересмотр шагов и ветвление гипотез. Готовый npm-комплект; сервер не вызывает отдельную модель и не требует API-ключа.', tags: ['Планирование', 'npm', 'Готовый комплект'] },
];

/** Зависимости собираются на площадке; при запуске MCP не обращается к реестру npm. */
export async function prepareNpmTool(tool, directory) {
    const lock = new URL(`./locks/${tool.key}.json`, import.meta.url);
    await fs.mkdir(directory, { recursive: true });
    try { await fs.copyFile(lock, path.join(directory, 'package-lock.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await installDependencies(directory, { [tool.package]: tool.version }, 'darwin-arm64');
    await fs.mkdir(new URL('./locks/', import.meta.url), { recursive: true });
    try { await fs.copyFile(path.join(directory, 'package-lock.json'), lock, (await import('node:fs')).constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const entry = `./node_modules/${tool.package}/dist/index.js`;
    const prelude = tool.key === 'filesystem' ? ''
        : tool.key === 'memory' ? "import fs from 'node:fs/promises';\nimport path from 'node:path';\nconst data = path.join(process.cwd(), '.opencode', 'neurocenter-memory');\nawait fs.mkdir(data, { recursive: true });\nprocess.env.MEMORY_FILE_PATH = path.join(data, 'memory.jsonl');\n" : "process.env.DISABLE_THOUGHT_LOGGING = 'true';\n";
    const start = tool.key === 'filesystem' ? 'await main([process.cwd()]);\n'
        : tool.key === 'sequential-thinking' ? "const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');\nawait main(new StdioServerTransport());\n" : 'await main();\n';
    await fs.writeFile(path.join(directory, 'entrypoint.mjs'), prelude + `const { main } = await import(${JSON.stringify(entry)});\n` + start);
    const nativeFiles = [];
    async function check(folder) {
        for (const item of await fs.readdir(folder, { withFileTypes: true })) {
            const file = path.join(folder, item.name);
            if (item.isDirectory()) await check(file);
            else if (/\.(node|dll|dylib|so|exe)$/i.test(item.name)) nativeFiles.push(file);
        }
    }
    await check(directory);
    if (nativeFiles.length) throw new Error('Общий JS-комплект содержит нативные зависимости. Нужна отдельная платформенная сборка.');
    return { entrypoint: 'entrypoint.mjs' };
}

export const filePlugins = [
    { key: 'project-context', name: 'Контекст проекта', revision: '1.0.1', description: 'Автоматически добавляет менеджер пакетов и названия scripts из package.json в контекст OpenCode. Не запускает команды. Отдельный JS-файл без зависимостей.', tags: ['Контекст', 'JS-файл', 'Без зависимостей'] },
    { key: 'git-context', name: 'Контекст Git', description: 'Добавляет текущую ветку и краткий список изменений Git в контекст OpenCode. Только локальное чтение, без сети. Отдельный JS-файл без зависимостей; требуется установленный Git.', tags: ['Git', 'JS-файл', 'Контекст'] },
];

export async function filePluginPublication(tool) {
    return { name: tool.name, kind: 'plugin', description: tool.description, tags: tool.tags, origin: 'neurocenter:catalog-plugins', revision: tool.revision ?? '1.0.0',
        compatibility: 'OpenCode: legacy Plugin API; JS, Node ≥24', config: { entrypoint: `${tool.key}.mjs` },
        files: [{ path: `${tool.key}.mjs`, content: await fs.readFile(new URL(`./plugins/${tool.key}.mjs`, import.meta.url), 'utf8') }] };
}
