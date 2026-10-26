import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Scope direct build-input downloads to the CLI phase and restore its environment after completion. */
export async function withBuildNetwork(work) {
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try { return await work(); }
    finally {
        if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
}

/** Isolate dependency credentials/config and apply the project's relaxed build TLS policy. */
export async function withNpmBuildEnvironment(environment, work) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-npm-build-'));
    const userconfig = path.join(home, 'user.npmrc'), globalconfig = path.join(home, 'global.npmrc');
    try {
        await Promise.all([fs.writeFile(userconfig, ''), fs.writeFile(globalconfig, '')]);
        const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !/^npm_config_/i.test(key)
            && !['NPM_TOKEN', 'NODE_AUTH_TOKEN'].includes(key.toUpperCase())));
        await work({env: {...env, HOME: home, USERPROFILE: home, NPM_CONFIG_STRICT_SSL: 'false', npm_config_strict_ssl: 'false', NODE_TLS_REJECT_UNAUTHORIZED: '0'}, args: [
            '--registry=https://registry.npmjs.org/', '--strict-ssl=false',
            '--userconfig=' + userconfig, '--globalconfig=' + globalconfig,
        ]});
    } finally { await fs.rm(home, {recursive: true, force: true}); }
}
