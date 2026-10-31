import { runtimeArtifactConnection } from '../features/runtime-artifacts/connection.js';
import { configurationConnection } from '../features/local-configuration/launcher-descriptor.js';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, parseTree, type Node, type ParseError } from 'jsonc-parser';
import type { Package } from './package.js';
import { assetBase } from './installation-receipt.js';

/** Неоднозначные повторные ключи JSONC не становятся доказательством владения. */
export function parseProjectConfig(source: string): Record<string, unknown> {
    const errors: ParseError[] = [];
    const tree = parseTree(source, errors, { allowTrailingComma: true });
    const visit = (node: Node): void => {
        if (node.type === 'object') {
            const keys = (node.children ?? []).map((property) => property.children?.[0]?.value);
            if (new Set(keys).size !== keys.length) {
                throw new Error('Некорректная конфигурация проекта.');
            }
        }
        for (const child of node.children ?? []) {
            visit(child);
        }
    };
    if (!tree || errors.length) {
        throw new Error('Некорректная конфигурация проекта.');
    }
    visit(tree);
    const config = parse(source, [], { allowTrailingComma: true }) as Record<string, unknown>;
    if (
        !config ||
        typeof config !== 'object' ||
        Array.isArray(config) ||
        (config.mcp !== undefined && (!config.mcp || typeof config.mcp !== 'object' || Array.isArray(config.mcp))) ||
        (config.plugin !== undefined && !Array.isArray(config.plugin))
    ) {
        throw new Error('Некорректная конфигурация проекта.');
    }
    return config;
}
/** Ожидаемое подключение вычисляется только из одобренного пакета, без запуска команды. */
export function expectedAdoptConnection(root: string, pkg: Package): unknown {
    const configured = configurationConnection(root, pkg);
    if (configured) {
        return configured;
    }
    const runtime = runtimeArtifactConnection(pkg);
    if (runtime) {
        return pkg.plugin.kind === 'plugin'
            ? pathToFileURL(runtime.entrypoint).href
            : {
                  type: 'local',
                  enabled: true,
                  command: runtime.command,
                  ...(pkg.config?.env ? { environment: pkg.config.env } : {}),
              };
    }
    if (pkg.plugin.kind === 'skill') {
        return undefined;
    }
    const config = pkg.config;
    if (pkg.plugin.kind === 'plugin') {
        if (!config?.entrypoint || !pkg.files.some((file) => file.path === config.entrypoint)) {
            throw new Error('Нет точки входа плагина.');
        }
        return pathToFileURL(path.join(root, assetBase(pkg), config.entrypoint)).href;
    }
    if (!config) {
        throw new Error('Нет подключения MCP.');
    }
    if (config.transport === 'remote') {
        const url = new URL(config.url ?? '');
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            throw new Error('Некорректное подключение MCP.');
        }
        return {
            type: 'remote',
            enabled: true,
            url: url.href,
            ...(config.headers ? { headers: config.headers } : {}),
            ...(config.oauth === false ? { oauth: false } : {}),
        };
    }
    if (
        !config.command ||
        (pkg.files.length && (!config.entrypoint || !pkg.files.some((file) => file.path === config.entrypoint)))
    ) {
        throw new Error('Нет точки входа MCP.');
    }
    return {
        type: 'local',
        enabled: true,
        command: pkg.files.length
            ? [process.execPath, path.join(root, assetBase(pkg), config.entrypoint!), ...(config.args ?? [])]
            : [config.command, ...(config.args ?? [])],
        ...(config.env ? { environment: config.env } : {}),
    };
}
export function configSpecInside(value: unknown, root: string, pkg: Package): boolean {
    if (typeof value !== 'string') {
        return false;
    }
    try {
        const url = new URL(value);
        if (url.protocol !== 'file:' || url.hostname || url.hash || url.search) {
            return false;
        }
        const relative = path.relative(path.join(root, assetBase(pkg)), fileURLToPath(url));
        return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
    } catch {
        return false;
    }
}
