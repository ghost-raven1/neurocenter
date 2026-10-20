import { hash } from './state.js';
import { canonical, type Package } from './package.js';
import { CONFIG_PATHS } from './installation-files.js';

export interface Receipt {
    version: number;
    manifest: string;
    files: Record<string, string>;
    encodings?: Record<string, 'base64'>;
    config?: { path: string; key: string; value: unknown };
}
export const sameValue = (a: unknown, b: unknown): boolean =>
    JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const assetKey = (pkg: Package): string =>
    hash(pkg.plugin.kind + ':' + pkg.plugin.id).slice(0, 24);
export const legacyMcpConfigKey = (pkg: Package): string =>
    'neurocenter_' + assetKey(pkg);
/** Читаемое имя MCP из названия инструмента; хэш-ключ остаётся запасным, если имя не slug-ируется. */
export const mcpConfigKey = (pkg: Package): string => {
    const slug = pkg.plugin.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) ? 'neurocenter-' + slug : legacyMcpConfigKey(pkg);
};
export const assetBase = (pkg: Package): string =>
    pkg.plugin.kind === 'skill'
        ? `.opencode/skills/${pkg.plugin.name}`
        : `.opencode/${pkg.plugin.kind}-bundles/${assetKey(pkg)}`;
export const receiptPath = (pkg: Package): string =>
    `.opencode/neurocenter/receipts/${assetKey(pkg)}.json`;

/** Удаление сверяет квитанцию с исходным серверным пакетом, включая полный набор файлов. */
export function removalReceipt(text: string, pkg: Package): Receipt {
    let receipt: Receipt;
    try {
        const parsed = JSON.parse(text) as Receipt | null;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error();
        }
        receipt = parsed;
    } catch {
        throw new Error(
            'Квитанция установки повреждена или изменена. Файлы не удалены.',
        );
    }
    const expectedFiles = Object.fromEntries(
        pkg.files.map((file) => [
            `${assetBase(pkg)}/${file.path}`,
            file.sha256,
        ]),
    );
    if (
        receipt.version !== pkg.plugin.version ||
        receipt.manifest !== pkg.manifest.sha256
    ) {
        throw new Error(
            'Локально уже другая версия инструмента. Обновите список установок перед удалением.',
        );
    }
    const encodings = Object.fromEntries(pkg.files.filter(file => file.encoding).map(file => [`${assetBase(pkg)}/${file.path}`, file.encoding]));
    if (!sameValue(receipt.files, expectedFiles) || !sameValue(receipt.encodings ?? {}, encodings)) {
        throw new Error(
            'Квитанция установки повреждена или изменена. Файлы не удалены.',
        );
    }
    if (pkg.plugin.kind === 'skill' && receipt.config) {
        throw new Error(
            'В квитанции скилла обнаружена посторонняя конфигурация.',
        );
    }
    const connectionKeys =
        pkg.plugin.kind === 'mcp'
            ? [mcpConfigKey(pkg), legacyMcpConfigKey(pkg)]
            : ['plugin'];
    if (
        pkg.plugin.kind !== 'skill' &&
        (!receipt.config ||
            !CONFIG_PATHS.includes(receipt.config.path) ||
            !connectionKeys.includes(receipt.config.key))
    ) {
        throw new Error(
            'Квитанция подключения повреждена. Конфигурация не изменена.',
        );
    }
    return receipt;
}
