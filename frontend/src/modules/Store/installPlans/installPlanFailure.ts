import { isAxiosError } from 'axios';
import type { IStoreApp, TStoreKind } from '../../../features/Catalog/types';

export interface IInstallPackageIdentity { kind: TStoreKind; id: string; name: string; version: number }
export interface IPackageInstallFailure {
    message: string;
    reason: string;
    package: IInstallPackageIdentity;
    root: IInstallPackageIdentity;
    dependency: boolean;
    path: IInstallPackageIdentity[];
}
export interface IInstallPlanFailure { app: IStoreApp; issue: IPackageInstallFailure }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && !!value.trim()
    && value.length <= limit && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const samePackage = (left: IInstallPackageIdentity, right: IInstallPackageIdentity): boolean => left.kind === right.kind
    && left.id === right.id && left.version === right.version && left.name === right.name;

function identity(value: unknown): IInstallPackageIdentity | null {
    if (!record(value) || typeof value.kind !== 'string' || !['skill', 'mcp', 'plugin'].includes(value.kind) || !text(value.id, 500)
        || !text(value.name, 500) || /[\x00-\x1f\x7f]/.test(value.id + value.name)
        || !Number.isSafeInteger(value.version) || (value.version as number) < 1) { return null; }
    return { kind: value.kind as TStoreKind, id: value.id, name: value.name, version: value.version as number };
}

/** Отказ относится только к точному запросу; повреждённый путь не становится действием интерфейса. */
export function parseInstallPlanFailure(cause: unknown, app: IStoreApp): IPackageInstallFailure | null {
    if (!isAxiosError(cause) || cause.response?.status !== 409) { return null; }
    const data: unknown = cause.response.data;
    if (!record(data) || data.code !== 'PACKAGE_NOT_INSTALLABLE' || !text(data.message, 4096) || !text(data.reason, 4096)
        || typeof data.dependency !== 'boolean' || !Array.isArray(data.path) || !data.path.length || data.path.length > 20) { return null; }
    const root = identity(data.root), pkg = identity(data.package), path = data.path.map(identity);
    if (!root || !pkg || path.some(item => !item) || root.kind !== app.kind || root.id !== app.id || root.version !== app.version) { return null; }
    const packages = path as IInstallPackageIdentity[];
    if (!samePackage(packages[0], root) || !samePackage(packages[packages.length - 1], pkg)
        || data.dependency !== (packages.length > 1)
        || new Set(packages.map(item => `${item.kind}:${item.id}`)).size !== packages.length) { return null; }
    return { message: data.message, reason: data.reason, package: pkg, root, dependency: data.dependency, path: packages };
}

/** Уточнение подходит только известной причине; остальные отказы сохраняют сообщение сервера. */
export function installPlanFailureExplanation(issue: IPackageInstallFailure): string {
    return issue.reason === 'Внешняя команда MCP не входит в закреплённый пакет. Загрузите готовый Node-пакет с точкой входа или используйте удалённый MCP.'
        ? 'В этой версии нет готового комплекта. Команда запуска MCP не включена в закреплённые файлы. Подготовьте комплект через мастер упаковки или подключите удалённый MCP.'
        : issue.reason;
}
