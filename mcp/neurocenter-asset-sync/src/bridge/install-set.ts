import { canonicalV4, verify, type Package } from './package.js';
import { hash } from './state.js';

export interface PackageRef {
    kind: string;
    id: string;
    version: number;
    manifest: string;
}
export interface InstallSet {
    schemaVersion: 1;
    root: PackageRef;
    packages: Package[];
    manifest: string;
}
const ordinal = (a: string, b: string): number => a === b ? 0 : a < b ? -1 : 1;
export const referenceKey = (ref: Pick<PackageRef, 'kind' | 'id'>): string => ref.kind + ':' + ref.id;
export const packageRef = (pkg: Package): PackageRef => ({
    kind: pkg.plugin.kind, id: pkg.plugin.id, version: pkg.plugin.version, manifest: pkg.manifest.sha256,
});
export const sortedRefs = (packages: Package[]): PackageRef[] => packages.map(packageRef)
    .sort((a, b) => ordinal(a.kind, b.kind) || ordinal(a.id, b.id));
export const installSetManifest = (root: PackageRef, packages: Package[]): string => hash(JSON.stringify(
    canonicalV4({ schemaVersion: 1, root, packages: sortedRefs(packages) }),
));
function validRef(ref: PackageRef, dependency = false): boolean {
    return !!ref && typeof ref === 'object' && !Array.isArray(ref)
        && (dependency ? ['mcp', 'plugin'] : ['skill', 'mcp', 'plugin']).includes(ref.kind)
        && typeof ref.id === 'string' && ref.id.length > 0 && ref.id.length <= 500
        && Number.isSafeInteger(ref.version) && ref.version > 0 && /^[a-f0-9]{64}$/.test(ref.manifest);
}
export function packageDependencies(pkg: Package): PackageRef[] {
    const requirements = pkg.config?.extra?.requirements;
    if (!requirements) { return []; }
    if ((requirements.mcp !== undefined && (!Array.isArray(requirements.mcp) || requirements.mcp.length))
        || (requirements.plugins !== undefined && (!Array.isArray(requirements.plugins) || requirements.plugins.length))) {
        throw new Error('Зависимости без закреплённых версий не поддерживаются. Обновите описание инструмента.');
    }
    const dependencies = requirements.dependencies ?? [];
    if (!Array.isArray(dependencies) || dependencies.length > 20 || dependencies.some(ref => !validRef(ref, true))) {
        throw new Error('Некорректные закреплённые зависимости пакета.');
    }
    if (new Set(dependencies.map(referenceKey)).size !== dependencies.length) {
        throw new Error('Повтор зависимости в пакете.');
    }
    return dependencies;
}

/** Проверяет точное замыкание и общий бюджет набора до доступа к локальному проекту. */
export function verifyInstallSet(set: InstallSet): PackageRef[] {
    if (!set || set.schemaVersion !== 1 || !validRef(set.root) || !Array.isArray(set.packages)
        || set.packages.length < 2 || set.packages.length > 20 || !/^[a-f0-9]{64}$/.test(set.manifest)) {
        throw new Error('Некорректный набор установки.');
    }
    const packages = new Map<string, Package>();
    let files = 0;
    let bytes = 0;
    for (const pkg of set.packages) {
        verify(pkg);
        if (!validRef(packageRef(pkg))) { throw new Error('Некорректная версия пакета набора.'); }
        const key = referenceKey(packageRef(pkg));
        if (packages.has(key)) { throw new Error('Повтор или конфликт версий пакета в наборе.'); }
        packages.set(key, pkg);
        files += pkg.files.length;
        bytes += pkg.files.reduce((total, file) => total + file.size, 0);
    }
    if (files > 200 || bytes > 16 * 1048576) { throw new Error('Набор превышает лимит 200 файлов или 16 МБ.'); }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const walk = (ref: PackageRef, depth: number): void => {
        if (depth > 20) { throw new Error('Слишком глубокий граф зависимостей.'); }
        const key = referenceKey(ref);
        const pkg = packages.get(key);
        if (!pkg || pkg.plugin.version !== ref.version || pkg.manifest.sha256 !== ref.manifest) {
            throw new Error('В наборе отсутствует точная версия зависимости: ' + key);
        }
        if (visiting.has(key)) { throw new Error('Цикл зависимостей набора.'); }
        if (visited.has(key)) { return; }
        visiting.add(key);
        for (const dependency of packageDependencies(pkg)) { walk(dependency, depth + 1); }
        visiting.delete(key);
        visited.add(key);
    };
    walk(set.root, 1);
    if (visited.size !== packages.size) { throw new Error('В наборе есть лишние пакеты вне графа зависимостей.'); }
    if (installSetManifest(set.root, set.packages) !== set.manifest) { throw new Error('Хэш набора установки не совпадает.'); }
    return sortedRefs(set.packages);
}
