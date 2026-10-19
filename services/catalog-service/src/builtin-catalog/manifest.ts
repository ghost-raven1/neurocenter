import { isDeepStrictEqual } from 'node:util';
import type { IAiPluginCreate } from '../catalog/dto';
import { validatePublication } from '../publication/publication-validation';
import { normalizeRuntimeArtifacts, type RuntimeArtifact } from '../../../shared/runtime-artifacts.cjs';

export interface IBuiltinArtifact { descriptor: RuntimeArtifact; url: string }
export interface IBuiltinTool {
    key: string; publication: IAiPluginCreate; legacyOrigins: string[]; legacyPackages?: string[]; artifacts: IBuiltinArtifact[];
}
export interface IBuiltinManifest { schemaVersion: 1; release: string; tools: IBuiltinTool[] }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const strings = (value: unknown, pattern?: RegExp): value is string[] => Array.isArray(value) && value.length <= 20
    && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 256 && !/[\x00-\x1f\x7f]/.test(item) && (!pattern || pattern.test(item)))
    && new Set(value).size === value.length;

/** Поставка доверяет только закреплённым assets собственного GitHub release. */
export function validateBuiltinManifest(value: unknown): IBuiltinManifest {
    if (!record(value) || !exact(value, ['schemaVersion', 'release', 'tools']) || value.schemaVersion !== 1
        || typeof value.release !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.release) || /^(?:latest|main|master|head)$/i.test(value.release)
        || !Array.isArray(value.tools) || value.tools.length < 1 || value.tools.length > 100) {
        throw new Error('Нужны schemaVersion: 1, закреплённый release и от 1 до 100 инструментов.');
    }
    const keys = new Set<string>(), names = new Set<string>();
    const tools = value.tools.map((raw): IBuiltinTool => {
        if (!record(raw) || !exact(raw, ['key', 'publication', 'legacyOrigins', 'legacyPackages', 'artifacts'])
            || typeof raw.key !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(raw.key) || keys.has(raw.key)
            || !record(raw.publication) || Object.prototype.hasOwnProperty.call(raw.publication, 'publicationKey')
            || !strings(raw.legacyOrigins) || raw.legacyPackages !== undefined && !strings(raw.legacyPackages, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/)
            || !Array.isArray(raw.artifacts) || raw.artifacts.length > 8) {
            throw new Error('Проверьте уникальный key, публикацию, разрешённые старые источники и артефакты.');
        }
        const { publicationKey: _publicationKey, ...publication } = validatePublication(raw.publication);
        if (!publication.revision || /^(?:latest|main|master|HEAD)$/i.test(publication.revision) || names.has(publication.name.toLowerCase())) {
            throw new Error('Названия поставки должны быть уникальными, ревизии — закреплёнными.');
        }
        const artifacts = raw.artifacts.map((artifact): IBuiltinArtifact => {
            if (!record(artifact) || !exact(artifact, ['descriptor', 'url'])) { throw new Error('Нужны descriptor и URL артефакта.'); }
            const [descriptor] = normalizeRuntimeArtifacts([artifact.descriptor]);
            const url = `https://github.com/ghost-raven1/neurocenter/releases/download/${value.release}/${descriptor.sha256}.tar.gz`;
            if (artifact.url !== url) { throw new Error('Артефакт должен принадлежать закреплённому GitHub release Нейроцентра.'); }
            return { descriptor, url };
        });
        const declared = normalizeRuntimeArtifacts(publication.config?.extra?.runtimeArtifacts);
        const supplied = normalizeRuntimeArtifacts(artifacts.length ? artifacts.map(artifact => artifact.descriptor) : undefined);
        if (!isDeepStrictEqual(declared, supplied)) { throw new Error('Артефакты поставки не совпадают с конфигурацией публикации.'); }
        keys.add(raw.key); names.add(publication.name.toLowerCase());
        return { key: raw.key, publication, legacyOrigins: raw.legacyOrigins,
            ...(raw.legacyPackages ? { legacyPackages: raw.legacyPackages as string[] } : {}), artifacts };
    });
    return { schemaVersion: 1, release: value.release, tools };
}
