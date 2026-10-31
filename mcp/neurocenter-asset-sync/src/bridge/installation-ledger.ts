import fs from 'node:fs/promises';
import { hash } from './state.js';
import { safeTarget } from './workspace.js';
import { assetKey, type Receipt } from './installation-receipt.js';
import { packageDependencies, packageRef, type PackageRef } from './install-set.js';
import type { Package } from './package.js';
import type { InstallationPlan } from './installation-plan.js';

export const LEDGER_PATH = '.opencode/neurocenter/installations.json';
interface LedgerRef {
    key: string;
    version: number;
    manifest: string;
    kind?: string;
    id?: string;
    dependencies?: string[];
}
interface LedgerRoot {
    root: LedgerRef;
    manifest: string;
    packages: LedgerRef[];
    retained?: true;
}
interface Ledger {
    schemaVersion: 1;
    roots: Record<string, LedgerRoot>;
}
const keyPattern = /^[a-f0-9]{24}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const ref = (item: PackageRef): LedgerRef => ({ key: hash(item.kind + ':' + item.id).slice(0, 24), ...item });
function validRef(item: LedgerRef): boolean {
    return (
        !!item &&
        typeof item === 'object' &&
        keyPattern.test(item.key) &&
        Number.isSafeInteger(item.version) &&
        item.version > 0 &&
        digestPattern.test(item.manifest) &&
        (item.dependencies === undefined ||
            (Array.isArray(item.dependencies) &&
                item.dependencies.length <= 20 &&
                item.dependencies.every((key) => keyPattern.test(key)) &&
                new Set(item.dependencies).size === item.dependencies.length)) &&
        ((item.kind === undefined && item.id === undefined) ||
            (typeof item.kind === 'string' && typeof item.id === 'string' && ref(item as PackageRef).key === item.key))
    );
}

/** Владельцы закрепляют общий пакет: чужой root не может незаметно сменить его версию. */
export class InstallationLedger {
    private constructor(
        private readonly plan: InstallationPlan,
        private readonly data: Ledger,
    ) {}
    static async load(plan: InstallationPlan): Promise<InstallationLedger> {
        const raw = await plan.read(LEDGER_PATH);
        let data: Ledger;
        try {
            data = raw === null ? { schemaVersion: 1, roots: {} } : (JSON.parse(raw) as Ledger);
            if (
                !data ||
                data.schemaVersion !== 1 ||
                !data.roots ||
                typeof data.roots !== 'object' ||
                Array.isArray(data.roots) ||
                Object.keys(data.roots).length > 1000 ||
                Object.entries(data.roots).some(
                    ([key, root]) =>
                        !keyPattern.test(key) ||
                        !root ||
                        !validRef(root.root) ||
                        root.root.key !== key ||
                        !digestPattern.test(root.manifest) ||
                        !Array.isArray(root.packages) ||
                        root.packages.length < 1 ||
                        root.packages.length > 20 ||
                        root.packages.some((item) => !validRef(item)) ||
                        new Set(root.packages.map((item) => item.key)).size !== root.packages.length ||
                        root.packages.some(
                            (item) =>
                                (root.packages.length > 1 && item.dependencies === undefined) ||
                                item.dependencies?.some((key) => !root.packages.some((member) => member.key === key)),
                        ) ||
                        !root.packages.some((item) => item.key === key && item.manifest === root.root.manifest),
                )
            ) {
                throw new Error();
            }
        } catch {
            throw new Error('Повреждён реестр зависимостей. Автоматические изменения остановлены.');
        }
        const directory = await safeTarget(plan.root, '.opencode/neurocenter/receipts');
        const files = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') {
                return [];
            }
            throw error;
        });
        if (files.length > 1000) {
            throw new Error('Слишком много локальных квитанций установки.');
        }
        const found = new Set<string>();
        for (const name of files.filter((name) => /^[a-f0-9]{24}\.json$/.test(name))) {
            const key = name.slice(0, -5);
            let receipt: Receipt;
            try {
                receipt = JSON.parse((await plan.read('.opencode/neurocenter/receipts/' + name))!) as Receipt;
                if (
                    !Number.isSafeInteger(receipt.version) ||
                    receipt.version < 1 ||
                    !digestPattern.test(receipt.manifest)
                ) {
                    throw new Error();
                }
            } catch {
                throw new Error('Повреждена локальная квитанция установки: ' + name);
            }
            found.add(key);
            const references = Object.values(data.roots).flatMap((root) =>
                root.packages.filter((item) => item.key === key),
            );
            if (references.some((item) => item.version !== receipt.version || item.manifest !== receipt.manifest)) {
                throw new Error('Квитанция и реестр зависимостей расходятся. Автоматические изменения остановлены.');
            }
            if (references.length) {
                continue;
            }
            const item = { key, version: receipt.version, manifest: receipt.manifest };
            data.roots[key] = { root: item, manifest: item.manifest, packages: [item] };
        }
        if (Object.values(data.roots).some((root) => root.packages.some((item) => !found.has(item.key)))) {
            throw new Error('В реестре зависимостей отсутствует локальная квитанция. Проверьте установку вручную.');
        }
        return new InstallationLedger(plan, data);
    }
    assertInstall(rootKey: string, pkg: Package): void {
        const key = assetKey(pkg);
        for (const [ownerKey, owner] of Object.entries(this.data.roots)) {
            if (
                ownerKey !== rootKey &&
                owner.packages.some((item) => item.key === key && item.manifest !== pkg.manifest.sha256)
            ) {
                throw new Error(
                    'Версия зависимости закреплена другим инструментом: ' +
                        (owner.root.id ?? ownerKey) +
                        '. Обновите его отдельно.',
                );
            }
        }
    }
    assertRemoval(pkg: Package): void {
        const key = assetKey(pkg);
        for (const [ownerKey, owner] of Object.entries(this.data.roots)) {
            if (ownerKey !== key && owner.packages.some((item) => item.key === key)) {
                throw new Error(
                    'Инструмент используется как зависимость: ' +
                        (owner.root.id ?? ownerKey) +
                        '. Сначала удалите зависимый инструмент.',
                );
            }
        }
    }
    private retainDependencies(key: string, next: Set<string>): void {
        const members = new Map((this.data.roots[key]?.packages ?? []).map((item) => [item.key, item]));
        const closure = (start: LedgerRef): LedgerRef[] => {
            const visiting = new Set<string>();
            const visited = new Map<string, LedgerRef>();
            const visit = (item: LedgerRef): void => {
                if (visiting.has(item.key)) {
                    throw new Error('Повреждён цикл локального реестра зависимостей.');
                }
                if (visited.has(item.key)) {
                    return;
                }
                visiting.add(item.key);
                for (const dependency of item.dependencies ?? []) {
                    const member = members.get(dependency);
                    if (!member || member.key === key) {
                        throw new Error('Повреждена связь локального реестра зависимостей.');
                    }
                    visit(member);
                }
                visiting.delete(item.key);
                visited.set(item.key, item);
            };
            visit(start);
            return [...visited.values()].sort((a, b) => (a.key === b.key ? 0 : a.key < b.key ? -1 : 1));
        };
        for (const item of members.values()) {
            if (item.key !== key && !next.has(item.key) && !this.data.roots[item.key]) {
                this.data.roots[item.key] = {
                    root: item,
                    manifest: item.manifest,
                    packages: closure(item),
                    retained: true,
                };
            }
        }
    }
    async install(root: PackageRef, manifest: string, packages: Package[]): Promise<void> {
        const members = packages.map((pkg) => ({
            ...ref(packageRef(pkg)),
            dependencies: packageDependencies(pkg).map((pin) => ref(pin).key),
        }));
        const rootRef = members.find((item) => item.key === ref(root).key)!;
        this.retainDependencies(rootRef.key, new Set(members.map((item) => item.key)));
        for (const pkg of packages) {
            this.assertInstall(rootRef.key, pkg);
        }
        this.data.roots[rootRef.key] = { root: rootRef, manifest, packages: members };
        await this.save();
    }
    async remove(pkg: Package): Promise<void> {
        const key = assetKey(pkg);
        this.retainDependencies(key, new Set());
        delete this.data.roots[key];
        await this.save();
    }
    private async save(): Promise<void> {
        if (Object.keys(this.data.roots).length > 1000) {
            throw new Error('Превышен лимит локального реестра установок.');
        }
        await this.plan.write(LEDGER_PATH, JSON.stringify(this.data, null, 2) + '\n');
    }
}
