import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
const { normalizeRuntimeArtifacts, inspectRuntimeArchive } = require('../shared/runtime-artifacts.cjs');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Один источник и его закреплённая ревизия всегда повторяют тот же запрос публикации. */
export function publicationKey(key, revision) {
    const bytes = createHash('sha256').update(`neurocenter-catalog-plugin\0${key}\0${revision}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function jsonFile(filename, limit) {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) { throw new Error('Нужен обычный JSON-файл допустимого размера.'); }
    return JSON.parse(await readFile(filename, 'utf8'));
}

/** Все инструменты и архивы проверяются до первого импорта или HTTP-запроса. */
export async function readyManifest(filename) {
    const manifestPath = await realpath(filename);
    const manifest = await jsonFile(manifestPath, 16 * 1024 * 1024);
    if (!object(manifest) || !exact(manifest, ['schemaVersion', 'tools']) || manifest.schemaVersion !== 1
        || !Array.isArray(manifest.tools) || !manifest.tools.length || manifest.tools.length > 100) { throw new Error('Ожидается manifest schemaVersion: 1 и от 1 до 100 tools.'); }
    let validatePublication;
    try { ({ validatePublication } = require('./dist/publication/publication-validation.js')); }
    catch { throw new Error('Сначала соберите catalog-service: npm run build в services/catalog-service.'); }
    const keys = new Set(), names = new Set(), prepared = [];
    const directory = path.dirname(manifestPath);
    for (const tool of manifest.tools) {
        if (!object(tool) || !exact(tool, ['key', 'publicationKey', 'publication', 'artifacts']) || typeof tool.key !== 'string'
            || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(tool.key) || keys.has(tool.key)
            || !object(tool.publication) || Object.hasOwn(tool.publication, 'publicationKey') || !Array.isArray(tool.artifacts)
            || tool.publicationKey !== undefined && (typeof tool.publicationKey !== 'string' || !uuid.test(tool.publicationKey))) {
            throw new Error('Проверьте уникальный key, publication без publicationKey и массив artifacts.');
        }
        const revision = tool.publication.revision;
        if (typeof revision !== 'string' || !revision.trim() || /^(?:latest|main|master|HEAD)$/i.test(revision)) { throw new Error(`${tool.key}: закрепите точную версию или commit в publication.revision.`); }
        const publication = validatePublication(tool.publication);
        if (names.has(publication.name.toLowerCase())) { throw new Error('В manifest повторяется название инструмента.'); }
        keys.add(tool.key); names.add(publication.name.toLowerCase());
        const artifacts = [];
        for (const artifact of tool.artifacts) {
            if (!object(artifact) || !exact(artifact, ['archivePath', 'descriptorPath'])
                || !['archivePath', 'descriptorPath'].every(key => typeof artifact[key] === 'string' && artifact[key] && !/[\x00-\x1f]/.test(artifact[key]))) {
                throw new Error(`${tool.key}: нужны archivePath и descriptorPath.`);
            }
            const archivePath = await realpath(path.resolve(directory, artifact.archivePath));
            const descriptorPath = await realpath(path.resolve(directory, artifact.descriptorPath));
            const [descriptor] = normalizeRuntimeArtifacts([await jsonFile(descriptorPath, 4096)]);
            await inspectRuntimeArchive(archivePath, descriptor);
            artifacts.push({ archivePath, descriptorPath, descriptor });
        }
        const declared = normalizeRuntimeArtifacts(publication.config?.extra?.runtimeArtifacts);
        const supplied = normalizeRuntimeArtifacts(artifacts.length ? artifacts.map(item => item.descriptor) : undefined);
        const canonical = list => JSON.stringify(list.map(item => Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))));
        if (canonical(declared) !== canonical(supplied)) { throw new Error(`${tool.key}: artifacts не совпадают с config.extra.runtimeArtifacts публикации.`); }
        prepared.push({ key: tool.key, publication: { ...publication, publicationKey: tool.publicationKey ?? publicationKey(tool.key, revision) }, artifacts });
    }
    return prepared;
}
