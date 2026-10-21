import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** Официальный Node 24 из проекта: берём новейший полный комплект своей ОС и архитектуры. */
function projectToolchains() {
    if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) return [];
    const directory = fileURLToPath(new URL('../../.run/toolchains/', import.meta.url));
    const pattern = new RegExp(`^node-v24\\.\\d+\\.\\d+-${process.platform}-${process.arch}$`);
    try {
        return fs.readdirSync(directory, {withFileTypes: true})
            .filter(entry => entry.isDirectory() && pattern.test(entry.name))
            .sort((left, right) => right.name.localeCompare(left.name, 'en', {numeric: true}))
            .filter(entry => {
                try {
                    return ['LICENSE', 'lib/node_modules/npm/bin/npm-cli.js']
                        .every(file => fs.statSync(path.join(directory, entry.name, file)).isFile());
                } catch { return false; }
            })
            .map(entry => path.join(directory, entry.name, 'bin/node'));
    } catch { return []; }
}

/** Все команды сборки и их npm-потомки используют один проверенный стабильный Node 24. */
export function nodeRuntime(environment = process.env) {
    const executable = process.platform === 'win32' ? 'node.exe' : 'node';
    const candidates = environment.NODE_BIN ? [environment.NODE_BIN] : [process.execPath,
        ...(environment.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, executable)),
        ...projectToolchains(),
        path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin', executable)];
    for (const candidate of new Set(candidates)) {
        const result = spawnSync(candidate, ['-p', 'JSON.stringify({version:process.versions.node,binary:process.execPath})'],
            {env: environment, encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true});
        if (result.status !== 0) continue;
        try {
            const info = JSON.parse(result.stdout);
            if (typeof info.version !== 'string' || !/^24\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(info.version) || !path.isAbsolute(info.binary)) continue;
            return {node: info.binary, version: info.version, env: {...environment,
                NODE_BIN: info.binary, PATH: [path.dirname(info.binary), environment.PATH].filter(Boolean).join(path.delimiter)}};
        } catch { /* Следующий установленный runtime. */ }
    }
    throw new Error(environment.NODE_BIN ? 'NODE_BIN должен указывать на работающий стабильный Node.js 24.' : 'Для проекта нужен стабильный Node.js 24. Укажите NODE_BIN или активируйте Node 24.');
}

/** npm запускается выбранным Node, независимо от shebang системного npm. */
export function npmCli(environment = process.env) {
    const candidates = [environment.NPM_CLI_JS, environment.npm_execpath];
    for (const directory of (environment.PATH || '').split(path.delimiter).filter(Boolean)) {
        candidates.push(path.join(directory, 'npm'), path.join(directory, 'node_modules/npm/bin/npm-cli.js'),
            path.join(directory, '../lib/node_modules/npm/bin/npm-cli.js'));
    }
    for (const candidate of candidates.filter(Boolean)) {
        try { const resolved = fs.realpathSync(candidate); if (resolved.endsWith('.js') && fs.statSync(resolved).isFile()) return resolved; }
        catch { /* Следующий установленный npm. */ }
    }
    throw new Error('На машине сборки нужен npm-cli.js. Установите npm или укажите NPM_CLI_JS.');
}
