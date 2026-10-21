import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Build dependencies with no inherited npm registry, credentials or user/global config. */
export async function withNpmBuildEnvironment(environment, work) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-npm-build-'));
    const userconfig = path.join(home, 'user.npmrc'), globalconfig = path.join(home, 'global.npmrc');
    try {
        await Promise.all([fs.writeFile(userconfig, ''), fs.writeFile(globalconfig, '')]);
        const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !/^npm_config_/i.test(key)
            && !['NPM_TOKEN', 'NODE_AUTH_TOKEN'].includes(key.toUpperCase())));
        await work({env: {...env, HOME: home, USERPROFILE: home}, args: [
            '--registry=https://registry.npmjs.org/', '--strict-ssl=true',
            '--userconfig=' + userconfig, '--globalconfig=' + globalconfig,
        ]});
    } finally { await fs.rm(home, {recursive: true, force: true}); }
}
