import { resolvePreparedRuntimeArtifact } from '../features/runtime-artifacts/cache.js';
import { runtimeArtifactConnection } from '../features/runtime-artifacts/connection.js';
import { configurationConnection } from '../features/local-configuration/launcher-descriptor.js';
import { pathToFileURL } from 'node:url';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { hash, hub, apiHub } from './state.js';
import { safeTarget } from './workspace.js';
import type { Package } from './package.js';
import {
    assetBase,
    legacyMcpConfigKey,
    mcpConfigKey,
    receiptPath as managedReceiptPath,
    sameValue as same,
    type Receipt,
} from './installation-receipt.js';
import { isHostedMcpUrl } from '../features/mcp-host/connect.js';
import { CONFIG_PATHS } from './installation-files.js';
import type { InstallationPlan } from './installation-plan.js';
import { repairReceipt } from './installation-repair.js';
import { CODEX_MANAGED_INSTALL_MESSAGE, isManagedCodexConnectorPackage } from './managed-codex-connector.js';

function parsePreviousReceipt(raw: string, base: string): Receipt {
    try {
        const receipt = JSON.parse(raw) as Receipt;
        if (
            !receipt ||
            !Number.isSafeInteger(receipt.version) ||
            receipt.version < 1 ||
            !/^[a-f0-9]{64}$/.test(receipt.manifest) ||
            !receipt.files ||
            typeof receipt.files !== 'object' ||
            Array.isArray(receipt.files) ||
            Object.keys(receipt.files).length > 100 ||
            Object.entries(receipt.files).some(
                ([relative, digest]) => !relative.startsWith(base + '/') || !/^[a-f0-9]{64}$/.test(digest),
            )
        ) {
            throw new Error();
        }
        return receipt;
    } catch {
        throw new Error('Некорректная квитанция предыдущей установки.');
    }
}

/** Готовит пакет без записи: все участники набора используют один снимок конфигурации. */
export interface PlanInstallOptions {
    repair?: boolean;
    runtimeRepairPreview?: boolean;
    hostedMcp?: (pkg: Package) => Promise<string>;
}

export async function planInstall(
    plan: InstallationPlan,
    pkg: Package,
    options: PlanInstallOptions = {},
): Promise<void> {
    if (isManagedCodexConnectorPackage(pkg)) throw new Error(CODEX_MANAGED_INSTALL_MESSAGE);
    const root = plan.root;
    if (options.runtimeRepairPreview && !options.repair) {
        throw new Error('Пропуск проверки кэша допустим только в явном сравнении восстановления.');
    }
    const runtime = runtimeArtifactConnection(pkg);
    const configured = configurationConnection(root, pkg);
    const base = assetBase(pkg);
    const receiptPath = managedReceiptPath(pkg);
    const wantsHosted =
        pkg.plugin.kind === 'mcp' &&
        !!runtime &&
        !configured &&
        (pkg.config?.transport ?? 'local') !== 'remote' &&
        pkg.config?.extra?.hostedMcp === true;
    const useHosted = wantsHosted && !options.repair && !!options.hostedMcp;
    const raw = await plan.read(receiptPath);
    if (options.repair && !raw) {
        throw new Error('Нет квитанции текущей установки. Автоматическое восстановление недоступно.');
    }
    const previous = raw
        ? options.repair
            ? await repairReceipt(plan, raw, pkg)
            : parsePreviousReceipt(raw, base)
        : undefined;
    const previousHosted =
        !!previous?.config &&
        previous.config.value !== null &&
        typeof previous.config.value === 'object' &&
        (previous.config.value as { type?: unknown; url?: unknown }).type === 'remote' &&
        isHostedMcpUrl((previous.config.value as { url?: unknown }).url);
    // Платформа исполняет комплекс: локальный архив для него не скачивается и не проверяется.
    if (!options.runtimeRepairPreview && !useHosted && !(options.repair && previousHosted)) {
        await resolvePreparedRuntimeArtifact(pkg);
        plan.expectRuntimeArtifact(pkg);
    }
    const planned = new Map(pkg.files.map((file) => [`${base}/${file.path}`, file]));
    const files: Record<string, string> = {};
    for (const [relative, expected] of Object.entries(previous?.files || {})) {
        if (!relative.startsWith(base + '/')) {
            throw new Error('Некорректная квитанция предыдущей установки.');
        }
        const current = await plan.read(relative, 'base64');
        if (!options.repair && (current === null || hash(Buffer.from(current, 'base64')) !== expected)) {
            throw new Error(
                'Файл изменён вручную или удалён: ' + relative + '. Сохраните изменения перед обновлением.',
            );
        }
        if (!planned.has(relative)) {
            await plan.write(relative, null, 'base64');
        }
    }
    for (const [relative, file] of planned) {
        const { content, encoding } = file;
        const before = await plan.read(relative, 'base64');
        const after = Buffer.from(content, encoding ?? 'utf8').toString('base64');
        if (
            !options.repair &&
            previous?.files[relative] &&
            (before === null || hash(Buffer.from(before, 'base64')) !== previous.files[relative])
        ) {
            throw new Error('Файл изменён вручную во время подготовки: ' + relative);
        }
        if (before !== null && !previous?.files[relative]) {
            throw new Error('Файл уже существует и не управляется Нейроцентром: ' + relative);
        }
        files[relative] = file.sha256;
        if (before !== after) {
            await plan.write(relative, after, 'base64');
        }
    }
    const receipt: Receipt = {
        version: pkg.plugin.version,
        manifest: pkg.manifest.sha256,
        files,
        ...(pkg.files.some((file) => file.encoding)
            ? {
                  encodings: Object.fromEntries(
                      pkg.files.filter((file) => file.encoding).map((file) => [`${base}/${file.path}`, file.encoding!]),
                  ),
              }
            : {}),
    };
    if (pkg.plugin.kind !== 'skill') {
        const candidates = CONFIG_PATHS;
        let configPath = previous?.config?.path || 'opencode.json';
        let text: string | null = null;
        for (const candidate of previous?.config ? [previous.config.path] : candidates) {
            const found = await plan.read(candidate);
            if (found !== null) {
                configPath = candidate;
                text = found;
                break;
            }
        }
        if (!candidates.includes(configPath)) {
            throw new Error('Некорректный путь конфигурации в квитанции.');
        }
        const source = text ?? '{}\n';
        const errors: ParseError[] = [];
        const parsed = parse(source, errors, {
            allowTrailingComma: true,
        }) as Record<string, unknown> | null;
        if (errors.length || !parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
            throw new Error('Исправьте JSON/JSONC конфигурации OpenCode. Файл не изменён.');
        }
        const mcpKey = mcpConfigKey(pkg);
        const legacyKey =
            previous?.config?.key === legacyMcpConfigKey(pkg) && legacyMcpConfigKey(pkg) !== mcpKey
                ? legacyMcpConfigKey(pkg)
                : undefined;
        const mcpEntries = (parsed.mcp ?? {}) as Record<string, unknown>;
        let value: unknown;
        let editPath: (string | number)[];
        if (pkg.plugin.kind === 'mcp') {
            const config = pkg.config;
            if (!config) {
                throw new Error('У MCP нет конфигурации подключения.');
            }
            if (
                parsed.mcp !== undefined &&
                (!parsed.mcp || Array.isArray(parsed.mcp) || typeof parsed.mcp !== 'object')
            ) {
                throw new Error('Поле mcp должно быть объектом.');
            }
            // Старые установки ещё хранят хэш-ключ: имя мигрируется один раз по квитанции.
            const migrated = legacyKey !== undefined ? mcpEntries[legacyKey] : undefined;
            const existing = mcpEntries[mcpKey] ?? migrated;
            if (!options.repair && legacyKey !== undefined && mcpEntries[mcpKey] !== undefined) {
                throw new Error('Подключение MCP изменено вручную.');
            }
            if (
                !options.repair &&
                (previous?.config ? !same(existing, previous.config.value) : existing !== undefined)
            ) {
                throw new Error('Подключение MCP изменено вручную.');
            }
            if (configured) {
                value = configured;
            } else if (config.transport === 'remote') {
                const url = new URL(config.url || '');
                if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
                    throw new Error('Некорректный адрес MCP.');
                }
                value = {
                    type: 'remote',
                    enabled: true,
                    url: url.href,
                    ...(config.headers ? { headers: config.headers } : {}),
                    ...(config.oauth === false ? { oauth: false } : {}),
                };
            } else {
                const previousValue = previous?.config?.value as { type?: unknown; url?: unknown } | undefined;
                const previousIsHosted =
                    !!previousValue &&
                    typeof previousValue === 'object' &&
                    previousValue.type === 'remote' &&
                    isHostedMcpUrl(previousValue.url) &&
                    [hub(), apiHub()].includes(new URL(previousValue.url).origin);
                if (previousIsHosted) {
                    // Билет живёт до истечения: обновление и восстановление не переподключают канал.
                    value = {
                        type: 'remote',
                        enabled: true,
                        url: new URL(new URL(previousValue.url as string).pathname, apiHub()).href,
                    };
                } else if (useHosted) {
                    // Комплекс исполняет площадка: билет выдаётся здесь, локальный процесс не поднимается.
                    const channelPath = await options.hostedMcp!(pkg);
                    value = { type: 'remote', enabled: true, url: new URL(channelPath, apiHub()).href };
                } else {
                    if (!runtime && !config.command) {
                        throw new Error('Не задана команда MCP.');
                    }
                    if (
                        !runtime &&
                        pkg.files.length &&
                        (!config.entrypoint || !pkg.files.some((file) => file.path === config.entrypoint))
                    ) {
                        throw new Error('Точка входа MCP отсутствует в пакете.');
                    }
                    value = {
                        type: 'local',
                        enabled: true,
                        command: runtime
                            ? runtime.command
                            : pkg.files.length
                              ? [
                                    process.execPath,
                                    await safeTarget(root, `${base}/${config.entrypoint}`),
                                    ...(config.args || []),
                                ]
                              : [config.command, ...(config.args || [])],
                        ...(config.env ? { environment: config.env } : {}),
                    };
                }
            }
            editPath = ['mcp', mcpKey];
            receipt.config = { path: configPath, key: mcpKey, value };
        } else {
            if (
                !runtime &&
                (!pkg.config?.entrypoint || !pkg.files.some((file) => file.path === pkg.config?.entrypoint))
            ) {
                throw new Error('Не задана точка входа плагина.');
            }
            const plugins = parsed.plugin ?? [];
            if (!Array.isArray(plugins)) {
                throw new Error('Поле plugin должно быть массивом.');
            }
            const spec = pathToFileURL(
                runtime?.entrypoint ?? (await safeTarget(root, `${base}/${pkg.config!.entrypoint}`)),
            ).href;
            if (!options.repair && previous?.config && !plugins.includes(previous.config.value)) {
                throw new Error('Подключение плагина удалено или изменено вручную.');
            }
            if (!previous && plugins.includes(spec)) {
                throw new Error('Плагин уже подключён вручную.');
            }
            editPath = ['plugin'];
            receipt.config = {
                path: configPath,
                key: 'plugin',
                value: spec,
            };
            value = [...plugins.filter((item) => item !== previous?.config?.value), spec];
        }
        const formatting = {
            formattingOptions: {
                insertSpaces: true,
                tabSize: 2,
                eol: '\n',
            },
        };
        let out = applyEdits(source, modify(source, editPath, value, formatting));
        if (pkg.plugin.kind === 'mcp' && legacyKey !== undefined && mcpEntries[legacyKey] !== undefined) {
            out = applyEdits(out, modify(out, ['mcp', legacyKey], undefined, formatting));
        }
        if (out !== text) {
            await plan.write(configPath, out);
        }
    }
    await plan.write(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
}
