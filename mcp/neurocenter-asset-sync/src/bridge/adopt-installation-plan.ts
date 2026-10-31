import { resolvePreparedRuntimeArtifact } from '../features/runtime-artifacts/cache.js';
import path from 'node:path';
import { CONFIG_PATHS } from './installation-files.js';
import { InstallationPlan } from './installation-plan.js';
import { InstallationLedger, LEDGER_PATH } from './installation-ledger.js';
import { inspectLedger } from './inspection-ledger.js';
import {
    assetBase,
    assetKey,
    legacyMcpConfigKey,
    mcpConfigKey,
    receiptPath,
    removalReceipt,
    sameValue,
    type Receipt,
} from './installation-receipt.js';
import { verify, type Package } from './package.js';
import { packageDependencies, packageRef, sortedRefs, verifyInstallSet, type InstallSet } from './install-set.js';
import { InventoryReader } from './project-inventory-reader.js';
import { expectedAdoptConnection, parseProjectConfig, configSpecInside } from './project-inventory-config.js';
import { hash } from './state.js';

export interface FrozenAdoption {
    root: Package;
    packages: Package[];
    manifest: string;
}
/** Снимок одобренного графа никогда не разрешает зависимости по текущему head. */
export function frozenAdoption(pkg: Package, set: InstallSet | undefined): FrozenAdoption {
    pkg = structuredClone(pkg);
    set = set ? structuredClone(set) : undefined;
    verify(pkg);
    if (set) {
        verifyInstallSet(set);
        if (!sameValue(packageRef(pkg), set.root)) {
            throw new Error('Корневой пакет не совпадает с закреплённым набором.');
        }
        return {
            root: pkg,
            packages: sortedRefs(set.packages).map((ref) =>
                set!.packages.find((member) => member.plugin.kind === ref.kind && member.plugin.id === ref.id)!,
            ),
            manifest: set.manifest,
        };
    }
    if (packageDependencies(pkg).length) {
        throw new Error('Для принятия зависимостей требуется полный закреплённый набор.');
    }
    return { root: pkg, packages: [pkg], manifest: pkg.manifest.sha256 };
}
function commandInside(value: unknown, root: string, pkg: Package): boolean {
    if (!value || typeof value !== 'object' || !Array.isArray((value as { command?: unknown }).command)) {
        return false;
    }
    const base = path.join(root, assetBase(pkg));
    return (value as { command: unknown[] }).command.some((item) => {
        if (typeof item !== 'string') {
            return false;
        }
        const relative = path.relative(base, path.resolve(root, item));
        return (
            relative === '' ||
            (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
        );
    });
}
/** Строит исключительно новые квитанции и ledger; файлы пакетов и JSONC остаются побайтно прежними. */
export async function adoptionPlan(
    root: string,
    frozen: FrozenAdoption,
): Promise<{ plan: InstallationPlan; reader: InventoryReader; configs: Map<string, Record<string, unknown>> }> {
    const plan = new InstallationPlan(root);
    const reader = new InventoryReader(root);
    const ledger = await InstallationLedger.load(plan);
    const ledgerRaw = await plan.read(LEDGER_PATH);
    const key = assetKey(frozen.root);
    const bases = new Set<string>();
    const configs = new Map<string, Record<string, unknown>>();
    for (const relative of CONFIG_PATHS) {
        const raw = await plan.read(relative);
        if (raw !== null) {
            configs.set(relative, parseProjectConfig(raw));
        }
    }
    const knownReceipts: Array<{ key: string; value: Receipt }> = [];
    const receiptNames = (await reader.list('.opencode/neurocenter/receipts')) ?? [];
    if (receiptNames.length > 1000) {
        throw new Error('Слишком много квитанций установки.');
    }
    for (const name of receiptNames) {
        if (!/^[a-f0-9]{24}\.json$/.test(name)) {
            throw new Error('Неизвестная запись в каталоге квитанций. Принятие остановлено.');
        }
        const raw = await plan.read('.opencode/neurocenter/receipts/' + name);
        const value = JSON.parse(raw!) as Receipt;
        if (!value?.files || typeof value.files !== 'object' || Array.isArray(value.files)) {
            throw new Error('Повреждена существующая квитанция.');
        }
        knownReceipts.push({ key: name.slice(0, -5), value });
    }
    for (const member of frozen.packages) {
        await resolvePreparedRuntimeArtifact(member);
        plan.expectRuntimeArtifact(member);
        const base = assetBase(member);
        const normalized = base.normalize('NFC').toLowerCase();
        if (bases.has(normalized)) {
            throw new Error('Конфликт путей пакетов набора.');
        }
        bases.add(normalized);
        ledger.assertInstall(key, member);
        if (ledgerRaw && inspectLedger(Buffer.from(ledgerRaw), member) === 'invalid') {
            throw new Error('Повреждён реестр установок. Принятие остановлено.');
        }
        const raw = await plan.read(receiptPath(member));
        if (assetKey(member) === key && raw !== null) {
            throw new Error('Квитанция инструмента уже существует. Принятие не заменяет существующую установку.');
        }
        const existing = raw === null ? undefined : removalReceipt(raw, member);
        if (existing && (!ledgerRaw || inspectLedger(Buffer.from(ledgerRaw), member) !== 'valid')) {
            throw new Error('Существующая зависимость не подтверждена реестром.');
        }
        if (
            knownReceipts.some(
                (item) =>
                    item.key !== assetKey(member) &&
                    Object.keys(item.value.files).some((file) => {
                        const owned = file.normalize('NFC').toLowerCase();
                        return owned === normalized || owned.startsWith(normalized + '/');
                    }),
            )
        ) {
            throw new Error('Каталог уже принадлежит другому инструменту. Принятие остановлено.');
        }
        const files = await reader.tree(base);
        const expected = member.files.map((file) => base + '/' + file.path).sort();
        if (!sameValue([...files].sort(), expected)) {
            throw new Error('Локальный набор содержит лишние или отсутствующие файлы.');
        }
        const directories = new Set([base]);
        for (const file of expected) {
            let parent = path.posix.dirname(file);
            while (parent.startsWith(base + '/')) {
                directories.add(parent);
                parent = path.posix.dirname(parent);
            }
        }
        if (
            reader
                .values()
                .some(
                    (item) =>
                        item.type === 'directory' &&
                        item.fingerprint !== null &&
                        (item.relative === base || item.relative.startsWith(base + '/')) &&
                        !directories.has(item.relative),
                )
        ) {
            throw new Error('В каталоге есть посторонние папки.');
        }
        for (const file of member.files) {
            const relative = base + '/' + file.path;
            const current = await plan.read(relative, 'base64');
            if (
                current === null ||
                hash(Buffer.from(current, 'base64')) !== file.sha256 ||
                Buffer.from(current, 'base64').length !== file.size
            ) {
                throw new Error('Локальные файлы не совпадают с одобренным пакетом.');
            }
        }
        const receipt: Receipt = {
            version: member.plugin.version,
            manifest: member.manifest.sha256,
            files: Object.fromEntries(member.files.map((file) => [base + '/' + file.path, file.sha256])),
            ...(member.files.some((file) => file.encoding)
                ? {
                      encodings: Object.fromEntries(
                          member.files
                              .filter((file) => file.encoding)
                              .map((file) => [base + '/' + file.path, file.encoding!]),
                      ),
                  }
                : {}),
        };
        if (member.plugin.kind !== 'skill') {
            const expectedValue = expectedAdoptConnection(root, member);
            const configKey = mcpConfigKey(member);
            const legacyKey = legacyMcpConfigKey(member);
            const matches: Array<{ path: string; value: unknown; key: string }> = [];
            for (const [relative, config] of configs) {
                if (member.plugin.kind === 'mcp') {
                    for (const [entryKey, value] of Object.entries((config.mcp as Record<string, unknown>) ?? {})) {
                        // Квитанция фиксирует фактический ключ подключения, какой бы ни был на диске.
                        if (entryKey === configKey || entryKey === legacyKey) {
                            matches.push({ path: relative, value, key: entryKey });
                        } else if (sameValue(value, expectedValue) || commandInside(value, root, member)) {
                            throw new Error('Подключение имеет другого владельца или неоднозначно.');
                        }
                    }
                } else {
                    for (const value of (config.plugin as unknown[]) ?? []) {
                        if (sameValue(value, expectedValue) || configSpecInside(value, root, member)) {
                            matches.push({ path: relative, value, key: 'plugin' });
                        }
                    }
                }
            }
            if (matches.length !== 1 || !sameValue(matches[0]!.value, expectedValue)) {
                throw new Error('Подключение не совпадает с одобренным пакетом или неоднозначно.');
            }
            receipt.config = { path: matches[0]!.path, key: matches[0]!.key, value: expectedValue };
            if (
                knownReceipts.some(
                    (item) =>
                        item.key !== assetKey(member) &&
                        typeof item.value.config?.path === 'string' &&
                        item.value.config.path.normalize('NFC').toLowerCase() ===
                            receipt.config!.path.normalize('NFC').toLowerCase() &&
                        (member.plugin.kind === 'mcp'
                            ? item.value.config.key === configKey || item.value.config.key === legacyKey
                            : sameValue(item.value.config.value, expectedValue)),
                )
            ) {
                throw new Error('Подключение уже принадлежит другому инструменту.');
            }
        }
        if (existing && !sameValue(existing, receipt)) {
            throw new Error('Существующая квитанция зависимости отличается от точного пакета.');
        }
        if (!existing) {
            await plan.write(receiptPath(member), JSON.stringify(receipt, null, 2) + '\n');
        }
    }
    await ledger.install(packageRef(frozen.root), frozen.manifest, frozen.packages);
    await plan.verifySnapshot();
    await reader.verify();
    return { plan, reader, configs };
}
