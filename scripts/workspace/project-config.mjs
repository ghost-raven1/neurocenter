import fs from 'node:fs/promises';
import path from 'node:path';

const baseFile = 'neurocenter.config.json';
const localFile = 'neurocenter.config.local.json';

/** Strict policy schema: every unknown key or type fails instead of being ignored. */
const tlsKeys = Object.freeze({ disableTlsVerification: 'boolean' });
const rootKeys = Object.freeze({ tls: 'object' });

function checkSection(value, name, allowed) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(name + ': нужен объект.');
    for (const key of Object.keys(value))
        if (!Object.hasOwn(allowed, key)) throw new Error('Неизвестный ключ ' + name + '.' + key + '.');
    for (const [key, type] of Object.entries(allowed))
        if (Object.hasOwn(value, key) && typeof value[key] !== type)
            throw new Error(name + '.' + key + ': нужен тип ' + type + '.');
}

async function readPolicy(root, name) {
    let bytes;
    try {
        bytes = await fs.readFile(path.join(root, name), 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    let value;
    try {
        value = JSON.parse(bytes);
    } catch {
        throw new Error(name + ': некорректный JSON.');
    }
    checkSection(value, name, rootKeys);
    if (value.tls !== undefined) checkSection(value.tls, name + '.tls', tlsKeys);
    return value;
}

/** Единый ридер политики проекта: базовый файл + local-override, strict-схема. */
export async function projectConfig(root) {
    const base = await readPolicy(root, baseFile),
        local = await readPolicy(root, localFile);
    if (!base && !local) return null;
    return { ...(base ?? {}), ...(local ?? {}), tls: { ...(base?.tls ?? {}), ...(local?.tls ?? {}) } };
}

/**
 * Производные значения TLS-политики. Явное NEUROCENTER_TLS_DISABLE в source имеет приоритет,
 * затем local-override и базовый конфиг; отсутствующий конфиг — strict-дефолт (fail-closed).
 */
export async function projectTlsEnvironment(root, source = {}) {
    const explicit = source.NEUROCENTER_TLS_DISABLE;
    let disable;
    if (explicit !== undefined) {
        if (explicit !== '0' && explicit !== '1') throw new Error('NEUROCENTER_TLS_DISABLE должен быть 0 или 1.');
        disable = explicit === '1';
    } else {
        disable = (await projectConfig(root))?.tls?.disableTlsVerification === true;
    }
    return {
        NEUROCENTER_TLS_DISABLE: disable ? '1' : '0',
        NEUROCENTER_NPM_STRICT_SSL: disable ? 'false' : 'true',
        NODE_TLS_REJECT_UNAUTHORIZED: disable ? '0' : '1',
    };
}
