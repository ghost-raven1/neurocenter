import path from 'node:path';
import { runtimeArtifactConnection } from '../features/runtime-artifacts/connection.js';
import { fileURLToPath } from 'node:url';
import { parse, type ParseError } from 'jsonc-parser';
import type { Package } from './package.js';
import type { InstallationPlan } from './installation-plan.js';
import { CONFIG_PATHS } from './installation-files.js';
import { assetBase, legacyMcpConfigKey, mcpConfigKey, removalReceipt, type Receipt } from './installation-receipt.js';

function previousRoot(receipt: Receipt, pkg: Package): string | undefined {
    if (pkg.config?.extra?.runtimeArtifacts || pkg.config?.extra?.localConfiguration) {
        return undefined;
    }
    if (pkg.plugin.kind === 'skill' || pkg.config?.transport === 'remote' || !pkg.files.length) {
        return undefined;
    }
    let entry: unknown;
    if (pkg.plugin.kind === 'plugin') {
        if (typeof receipt.config?.value !== 'string') {
            throw new Error('Некорректное подключение в квитанции.');
        }
        const url = new URL(receipt.config.value);
        if (url.protocol !== 'file:' || url.search || url.hash || url.hostname) {
            throw new Error('Некорректное подключение в квитанции.');
        }
        entry = fileURLToPath(url);
    } else {
        const value = receipt.config?.value as { command?: unknown } | undefined;
        if (
            !value ||
            !Array.isArray(value.command) ||
            typeof value.command[0] !== 'string' ||
            !path.isAbsolute(value.command[0])
        ) {
            throw new Error('Некорректное подключение в квитанции.');
        }
        entry = value.command[1];
    }
    const suffix = path.sep + path.join(assetBase(pkg), pkg.config!.entrypoint!);
    if (typeof entry !== 'string' || !path.isAbsolute(entry) || !entry.endsWith(suffix)) {
        throw new Error('Подключение квитанции не принадлежит пакету.');
    }
    return entry.slice(0, -suffix.length) || path.parse(entry).root;
}

/** Только известная квитанция разрешает явное восстановление ручных правок и старого пути. */
export async function repairReceipt(plan: InstallationPlan, raw: string, pkg: Package): Promise<Receipt> {
    const receipt = removalReceipt(raw, pkg);
    if (pkg.plugin.kind === 'skill') {
        return receipt;
    }
    const sourceRoot = previousRoot(receipt, pkg);
    const candidates: Array<{ path: string; value: unknown }> = [];
    const mcpKeys = new Set([mcpConfigKey(pkg), legacyMcpConfigKey(pkg)]);
    const runtime = runtimeArtifactConnection(pkg);
    const bases = [...new Set([plan.root, sourceRoot].filter((root): root is string => !!root))].map((root) =>
        path.join(root, assetBase(pkg)),
    );
    if (runtime) {
        bases.push(path.dirname(runtime.entrypoint));
    }
    const ownedSpec = (value: unknown): boolean => {
        if (typeof value !== 'string') {
            return false;
        }
        try {
            const url = new URL(value);
            if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) {
                return false;
            }
            const candidate = path.resolve(fileURLToPath(url));
            return bases.some((base) => {
                const relative = path.relative(base, candidate);
                return (
                    !!relative &&
                    relative !== '..' &&
                    !relative.startsWith('..' + path.sep) &&
                    !path.isAbsolute(relative)
                );
            });
        } catch {
            return false;
        }
    };
    for (const relative of CONFIG_PATHS) {
        const source = await plan.read(relative);
        if (source === null) {
            continue;
        }
        const errors: ParseError[] = [];
        const config = parse(source, errors, { allowTrailingComma: true }) as Record<string, unknown> | null;
        if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) {
            throw new Error('Исправьте JSON/JSONC конфигурации перед восстановлением.');
        }
        if (pkg.plugin.kind === 'mcp') {
            if (
                config.mcp !== undefined &&
                (!config.mcp || typeof config.mcp !== 'object' || Array.isArray(config.mcp))
            ) {
                throw new Error('Поле mcp должно быть объектом.');
            }
            const mcpEntries = (config.mcp as Record<string, unknown> | undefined) ?? {};
            const entryKey = [...mcpKeys].find((known) => mcpEntries[known] !== undefined);
            const value = entryKey === undefined ? undefined : mcpEntries[entryKey];
            if (value !== undefined) {
                candidates.push({ path: relative, value });
            }
        } else {
            if (config.plugin !== undefined && !Array.isArray(config.plugin)) {
                throw new Error('Поле plugin должно быть массивом.');
            }
            for (const value of (config.plugin as unknown[]) ?? []) {
                if (value === receipt.config!.value || ownedSpec(value)) {
                    candidates.push({ path: relative, value });
                }
            }
        }
    }
    if (candidates.length > 1 || candidates.some((candidate) => candidate.path !== receipt.config!.path)) {
        throw new Error('Подключение неоднозначно в нескольких конфигурациях. Восстановление остановлено.');
    }
    // Для plugin меняем только единственный доказанный URL; остальные элементы массива сохраняются.
    if (pkg.plugin.kind === 'plugin' && candidates.length) {
        return { ...receipt, config: { ...receipt.config!, value: candidates[0]!.value } };
    }
    return receipt;
}
