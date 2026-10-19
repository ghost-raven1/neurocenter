import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { Pool } from 'pg';
import { normalizeDependencyPins } from '../../../shared/dependency-pins.cjs';
import { normalizeRuntimeArtifacts, validateRuntimeArtifactEntrypoints } from '../../../shared/runtime-artifacts.cjs';
import { verifyPackage, type IPackage } from '../catalog/bundle-package';
import { assertDeviceCatalogAsset } from './device-catalog-access';
import { parseLocalConfiguration } from './mcp-config-schema';

export interface IInstallationRef { kind: string; id: string; version: number; manifest: string }
export interface IInstallationSet {
    schemaVersion: 1;
    root: IInstallationRef;
    packages: IPackage[];
    manifest: string;
}
const key = (value: { kind: string; id: string }) => value.kind + ':' + value.id;
const ordinal = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => ordinal(a,b)).map(([name,item]) => [name,canonical(item)])) : value;
export const installationRef = (pkg: IPackage): IInstallationRef => ({ kind: pkg.plugin.kind, id: pkg.plugin.id, version: pkg.plugin.version, manifest: pkg.manifest.sha256 });
export const installationRefs = (packages: IPackage[]) => packages.map(installationRef).sort((a,b) => ordinal(key(a),key(b)));
const validRef = (value: IInstallationRef) => value && !Array.isArray(value)
    && Object.keys(value).length === 4 && Object.keys(value).every(name => ['kind','id','version','manifest'].includes(name))
    && ['skill','mcp','plugin'].includes(value.kind) && typeof value.id === 'string' && !!value.id && value.id.length <= 500
    && Number.isSafeInteger(value.version) && value.version > 0 && typeof value.manifest === 'string' && /^[a-f0-9]{64}$/.test(value.manifest);
const packageIdentity = (pkg: IPackage) => ({kind: pkg.plugin.kind, id: pkg.plugin.id, name: pkg.plugin.name, version: pkg.plugin.version});

/** Хэш набора закрепляет корень и точный состав без зависимости от порядка доставки. */
export function installationSetHash(root: IInstallationRef, packages: IPackage[]): string {
    return createHash('sha256').update(JSON.stringify(canonical({ schemaVersion: 1, root, packages: installationRefs(packages) }))).digest('hex');
}

/** Подготовка файлов не запускает внешнюю команду и не разрешает зависимость через latest. */
export function assertInstallablePackage(pkg: IPackage): void {
    let valid = false;
    try { valid = verifyPackage(pkg); } catch { /* Повреждённый снимок закрывается отказом. */ }
    if (!valid || !validRef(installationRef(pkg)) || typeof pkg.plugin.name !== 'string' || !pkg.plugin.name || pkg.plugin.name.length > 500) { throw new ConflictException('Целостность пакета не подтверждена.'); }
    assertDeliveryFiles(pkg);
    try { validateRuntimeArtifactEntrypoints(pkg.plugin.kind, normalizeRuntimeArtifacts(pkg.config?.extra?.runtimeArtifacts)); }
    catch { throw new ConflictException('Готовому плагину нужна точка входа .js, .mjs или .cjs без нативного запуска. Исправьте комплект до одобрения.'); }
    try{parseLocalConfiguration(pkg);}catch{throw new ConflictException('Схема локальной настройки MCP некорректна. Исправьте её до одобрения версии.');}
    if (pkg.plugin.kind === 'mcp' && pkg.config?.transport !== 'remote' && !normalizeRuntimeArtifacts(pkg.config?.extra?.runtimeArtifacts).length &&
        (pkg.config?.command !== 'node' || !pkg.config.entrypoint || !pkg.files.some(file => file.path === pkg.config?.entrypoint))) {
        throw new ConflictException('Внешняя команда MCP не входит в закреплённый пакет. Загрузите готовый Node-пакет с точкой входа или используйте удалённый MCP.');
    }
    packageDependencies(pkg);
}

/** Зеркало клиентского delivery-контракта: одобрение не выдаётся заведомо неустанавливаемым файлам. */
function assertDeliveryFiles(pkg: IPackage): void {
    if (!Array.isArray(pkg.files) || pkg.files.length > 100) { throw new ConflictException('В одном пакете допустимо до 100 файлов.'); }
    const paths = new Set<string>(); let totalBytes = 0;
    for (const file of pkg.files) {
        if (typeof file.path !== 'string' || !file.path || file.path.length > 240 || file.path.includes('\\') || file.path.startsWith('/')
            || file.path.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part)
                || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) {
            throw new ConflictException('Пакет содержит непереносимый путь файла.');
        }
        const path = file.path.toLowerCase();
        if (paths.has(path) || [...paths].some(other => other.startsWith(path + '/') || path.startsWith(other + '/'))) {
            throw new ConflictException('Пути файлов пакета конфликтуют, включая регистр букв.');
        }
        paths.add(path);
        if (file.size > 1048576) { throw new ConflictException('Файл пакета превышает 1 МиБ.'); }
        totalBytes += file.size;
    }
    if (totalBytes > 5 * 1048576) { throw new ConflictException('Один пакет превышает 5 МиБ.'); }
    if (pkg.plugin.kind === 'skill' && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pkg.plugin.name) || !paths.has('skill.md'))) {
        throw new ConflictException('Скиллу нужны техническое имя и файл SKILL.md.');
    }
}

/** Имена старого формата остаются подсказкой; выбор исполняемой версии требует явного pin. */
export function packageDependencies(pkg: IPackage) {
    const requirements = pkg.config?.extra?.requirements;
    if (requirements === undefined) { return []; }
    if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) { throw new ConflictException('Повреждены требования пакета.'); }
    const values = requirements as { mcp?: unknown; plugins?: unknown; dependencies?: unknown };
    for (const legacy of [values.mcp,values.plugins]) {
        if (legacy !== undefined && (!Array.isArray(legacy) || legacy.length)) {
            throw new ConflictException('Замените требования MCP/плагинов по имени на точные зависимости: инструмент, версия и SHA-256. Неполная установка остановлена.');
        }
    }
    try { return normalizeDependencyPins(values.dependencies); }
    catch { throw new ConflictException('Зависимости должны содержать точные ID, версии и SHA-256 без повторов.'); }
}

function assertBudget(packages: IPackage[]): void {
    if (packages.length > 20 || packages.reduce((sum,pkg) => sum + pkg.files.length,0) > 200 ||
        packages.reduce((sum,pkg) => sum + pkg.files.reduce((bytes,file) => bytes + file.size,0),0) > 16 * 1024 * 1024) {
        throw new ConflictException('Комплект превышает лимит: 20 инструментов, 200 файлов или 16 МиБ. Разделите установку.');
    }
}

/** Замкнутый граф не принимает лишние пакеты, несовместимые версии или циклы. */
export function verifyInstallationSet(set: IInstallationSet): boolean {
    try {
        if (!set || set.schemaVersion !== 1 || !Array.isArray(set.packages) || set.packages.length < 2 || !validRef(set.root)) { return false; }
        assertBudget(set.packages);
        const packages = new Map<string, IPackage>();
        for (const pkg of set.packages) {
            assertInstallablePackage(pkg);
            if (packages.has(key(pkg.plugin))) { return false; }
            packages.set(key(pkg.plugin),pkg);
        }
        const visiting = new Set<string>(); const visited = new Set<string>();
        const visit = (ref: IInstallationRef) => {
            const name = key(ref); const pkg = packages.get(name);
            if (!pkg || pkg.plugin.version !== ref.version || pkg.manifest.sha256 !== ref.manifest || visiting.has(name)) { throw new Error(); }
            if (visited.has(name)) { return; }
            visiting.add(name);
            for (const pin of packageDependencies(pkg)) { visit(pin); }
            visiting.delete(name); visited.add(name);
        };
        visit(set.root);
        return visited.size === packages.size && set.manifest === installationSetHash(set.root,set.packages);
    } catch { return false; }
}

/** Читает каждую закреплённую версию один раз; не подставляет head при конфликте. */
export async function resolveInstallationSet(pool: Pool, projectId: string, root: IPackage,
    build: (kind: string, id: string, version: number) => Promise<IPackage>): Promise<IInstallationSet | undefined> {
    const packages = new Map<string, IPackage>(); const visiting = new Set<string>();
    const visit = async (pkg: IPackage, parents: IPackage['plugin'][] = []) => {
        try { assertInstallablePackage(pkg); }
        catch (error) {
            const plugin = pkg?.plugin;
            if (!(error instanceof ConflictException) || !plugin || typeof plugin.name !== 'string' || !plugin.name || plugin.name.length > 500
                || !validRef({kind: plugin.kind, id: plugin.id, version: plugin.version, manifest: pkg.manifest?.sha256})) { throw error; }
            // Имя и путь зависимости раскрываются только после проверки её доступности в проекте.
            await assertDeviceCatalogAsset(pool, projectId, plugin.kind, plugin.id);
            const current = packageIdentity(pkg), path = [...parents, current], dependency = parents.length > 0;
            throw new ConflictException({
                statusCode: 409, error: 'Conflict', code: 'PACKAGE_NOT_INSTALLABLE',
                message: `${dependency ? 'Зависимость' : 'Инструмент'} «${current.name}», версия ${current.version}: ${error.message}`,
                reason: error.message, package: current, root: path[0], dependency, path,
            });
        }
        const name = key(pkg.plugin);
        if (visiting.has(name)) { throw new ConflictException('Зависимости образуют цикл. Исправьте опубликованные версии.'); }
        const known = packages.get(name);
        if (known) {
            if (known.plugin.version !== pkg.plugin.version || known.manifest.sha256 !== pkg.manifest.sha256) { throw new ConflictException('В комплекте требуются несовместимые версии одной зависимости.'); }
            return;
        }
        await assertDeviceCatalogAsset(pool,projectId,pkg.plugin.kind,pkg.plugin.id);
        packages.set(name,pkg); assertBudget([...packages.values()]); visiting.add(name);
        for (const pin of packageDependencies(pkg)) {
            const knownPin = packages.get(key(pin));
            const dependency = knownPin ?? await build(pin.kind,pin.id,pin.version);
            if (!dependency || !dependency.plugin || !dependency.manifest) { throw new ConflictException('Зависимость вернула повреждённый пакет: ' + pin.id); }
            if (dependency.plugin.kind !== pin.kind || dependency.plugin.id !== pin.id || dependency.plugin.version !== pin.version || dependency.manifest.sha256 !== pin.manifest) {
                throw new ConflictException('Зависимость изменилась или её версия недоступна: ' + pin.id + '. Выберите точную версию заново.');
            }
            await visit(dependency, [...parents, packageIdentity(pkg)]);
        }
        visiting.delete(name);
    };
    await visit(root);
    if (packages.size === 1) { return; }
    const members = [...packages.values()].sort((a,b) => ordinal(key(a.plugin),key(b.plugin)));
    const ref = installationRef(root);
    return { schemaVersion: 1, root: ref, packages: members, manifest: installationSetHash(ref,members) };
}
