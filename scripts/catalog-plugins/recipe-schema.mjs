import runtime from '../../services/shared/runtime-artifacts.cjs';
import { additionalSourceTargets, validateAdditionalSource } from './source-adapters.mjs';
import sourceEntrypoint from '../../services/shared/source-entrypoint.cjs';
import ragSource from '../../services/shared/opencode-rag-source.cjs';

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, max) => typeof value === 'string' && value.trim() === value && !!value && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** Готовый JS не требует компилятора на компьютере пользователя. */
export function javascriptEntrypoint(value) {
    if (!runtime.portablePath(value) || !/\.(?:js|mjs|cjs)$/.test(value)) {
        throw new Error('Точка входа должна быть готовым .js, .mjs или .cjs файлом. Для TypeScript используйте источник project со сборкой.');
    }
    return value;
}

/** Декларация описывает данные и закреплённый источник, без shell-команд и install hooks. */
export function validateRecipe(input) {
    if (!exact(input, ['schemaVersion', 'key', 'name', 'kind', 'description', 'revision', 'tags', 'config', 'source', 'targets'])
        || input.schemaVersion !== 1 || !text(input.key, 128) || !/^[a-z0-9][a-z0-9._-]*$/.test(input.key)
        || !text(input.name, 128) || !['mcp', 'plugin'].includes(input.kind)
        || typeof input.description !== 'string' || input.description.length > 2000 || input.description.includes('\0')
        || !text(input.revision, 200) || /^(?:latest|main|master|HEAD)$/i.test(input.revision)) {
        throw new Error('Нужен recipe schemaVersion: 1 с key, name, kind, description и закреплённой revision. Неизвестные поля запрещены.');
    }
    if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 20 || input.tags.some(tag => !text(tag, 40)))) {
        throw new Error('Укажите не более 20 текстовых тегов.');
    }
    const config = input.config ?? {};
    const allowedConfig = input.kind === 'mcp' ? ['transport', 'command', 'args', 'env', 'extra'] : ['extra'];
    if (!exact(config, allowedConfig) || config.transport !== undefined && config.transport !== 'stdio'
        || config.command !== undefined && config.command !== 'node'
        || config.extra !== undefined && !exact(config.extra, ['localConfiguration'])) {
        throw new Error('Builder сам задаёт точку входа и готовые архивы. В config допустимы локальный MCP node/stdio, args, env и extra.localConfiguration; shell-команды и runtimeArtifacts запрещены.');
    }
    const source = input.source;
    let normalizedSource = source;
    if (!object(source)) { throw new Error('Укажите объект source.'); }
    if ((source.type === 'runtime' || source.type==='archive' || source.type === 'repository' && source.runtimeSource) && input.kind !== 'mcp') { throw new Error('Автономный runtime поддерживает только MCP, не OpenCode plugin.'); }
    if (source.type === 'npm') {
        if (!exact(source, ['type', 'package', 'version', 'entrypoint']) || typeof source.package !== 'string' || !packageName.test(source.package)
            || typeof source.version !== 'string' || !semver.test(source.version)) { throw new Error('Источник npm требует package, точную semver version и entrypoint. latest, URL, Git и диапазоны версий не поддерживаются.'); }
        if (!runtime.portablePath(source.entrypoint) || !sourceEntrypoint.isSourceEntrypoint(source.entrypoint)) {
            throw new Error('npm entrypoint должен быть переносимым JS/TS-файлом внутри пакета.');
        }
    } else if (source.type === 'files') {
        const directory = typeof source.directory === 'string' ? source.directory.replace(/^\.\//, '') : '';
        if (!exact(source, ['type', 'directory', 'entrypoint']) || !directory || directory !== '.' && !runtime.portablePath(directory)) {
            throw new Error('Источник files требует относительный directory внутри папки recipe, без .. и абсолютных путей.');
        }
        javascriptEntrypoint(source.entrypoint);
    } else { normalizedSource = validateAdditionalSource(source) ?? source; }
    if (input.kind !== 'plugin' && (normalizedSource.type === 'prepared' && normalizedSource.adapter === 'opencode-rag-plugin'
        || normalizedSource.type === 'repository' && ragSource.isPreparedRagRepository(normalizedSource))) {
        throw new Error('Совместимый OpenCodeRAG из GitHub подключается как plugin. Для MCP используйте отдельный адаптер opencode-rag.');
    }
    const supported = additionalSourceTargets(normalizedSource) ?? runtime.TARGETS;
    const targets = input.targets ?? supported;
    if (!Array.isArray(targets) || !targets.length || targets.length > 8 || new Set(targets).size !== targets.length
        || targets.some(target => !runtime.TARGETS.includes(target) || !supported.includes(target))) {
        throw new Error('targets содержит повторяющуюся, неизвестную или неподдерживаемую источником платформу.');
    }
    return { ...structuredClone(input), source: structuredClone(normalizedSource), tags: [...new Set(input.tags ?? [])], config: structuredClone(config), targets: [...targets] };
}
