import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TRUSTED_REGISTRY } from '../supply/registry.mjs';

/** Scope direct build-input downloads to the CLI phase and restore its environment after completion. */
export async function withBuildNetwork(work) {
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
        return await work();
    } finally {
        if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
}

/**
 * Trusted-registry credentials arrive as base64 of the trusted-host npmrc lines
 * (NPM_REGISTRY_AUTH_B64, same variable as the Docker build-arg). Malformed input
 * fails closed; the decoded lines become the temporary globalconfig content.
 */
function registryAuthNpmrc(environment) {
    const encoded = environment?.NPM_REGISTRY_AUTH_B64;
    if (encoded === undefined) return '';
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
        throw new Error('NPM_REGISTRY_AUTH_B64: ожидался base64 без пробельных символов.');
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const lines = decoded.split('\n');
    if (!lines.length || lines.some((line) => !/^[^\s=][^=]*=\S+$/.test(line)))
        throw new Error('NPM_REGISTRY_AUTH_B64: декодированное значение не является набором npmrc-строк key=value.');
    return decoded.endsWith('\n') ? decoded : decoded + '\n';
}

/** Isolate dependency credentials/config and apply the project's relaxed build TLS policy. */
export async function withNpmBuildEnvironment(environment, work) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-npm-build-'));
    const userconfig = path.join(home, 'user.npmrc'),
        globalconfig = path.join(home, 'global.npmrc');
    try {
        await Promise.all([fs.writeFile(userconfig, ''), fs.writeFile(globalconfig, registryAuthNpmrc(environment))]);
        const env = Object.fromEntries(
            Object.entries(environment).filter(
                ([key]) => !/^npm_config_/i.test(key) && !['NPM_TOKEN', 'NODE_AUTH_TOKEN'].includes(key.toUpperCase()),
            ),
        );
        await work({
            env: {
                ...env,
                HOME: home,
                USERPROFILE: home,
                NPM_CONFIG_STRICT_SSL: 'false',
                npm_config_strict_ssl: 'false',
                NODE_TLS_REJECT_UNAUTHORIZED: '0',
            },
            args: [
                '--registry=' + TRUSTED_REGISTRY,
                '--strict-ssl=false',
                '--userconfig=' + userconfig,
                '--globalconfig=' + globalconfig,
            ],
        });
    } finally {
        await fs.rm(home, { recursive: true, force: true });
    }
}
