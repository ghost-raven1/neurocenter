import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { packageProbeEngine } from './bridge-runtime-probe.mjs';
import { packageWindowsJobHelper } from './bridge-windows-job.mjs';
import { verifyBridgeBuild } from './bridge-build-integrity.mjs';
import {npmCli} from './workspace/node-runtime.mjs';
import {withNpmBuildEnvironment} from './workspace/npm-build-environment.mjs';
import {packageBridgeOpenCodeSdk, verifyBridgeSdkArchive, SdkUnavailableError, SDK_UNAVAILABLE_EXIT_CODE} from './bridge-runtime-sdk.mjs';

// Собирать на целевой ОС и архитектуре: нативные модули не переносятся между платформами.
const root = fileURLToPath(new URL('../', import.meta.url));
const bridge = path.join(root, 'mcp/neurocenter-asset-sync');
const manifest = JSON.parse(await fs.readFile(path.join(bridge, 'package.json'), 'utf8'));
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Автономный пакет собирается поддерживаемым Node.js 24.');
const platform = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
if (!platform || !['x64', 'arm64'].includes(process.arch)) throw new Error('Эта платформа не входит в матрицу сборки.');
const build = await verifyBridgeBuild(path.join(bridge, 'dist'), manifest.version);
const musl = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
const target = `${platform}-${process.arch}${musl ? '-musl' : ''}`;
const output = process.env.BRIDGE_RUNTIME_OUTPUT_DIR
    ? path.resolve(process.env.BRIDGE_RUNTIME_OUTPUT_DIR)
    : path.join(root, 'bridge-dist/runtime');
await fs.mkdir(output, { recursive: true });
// Временный архив остаётся на томе назначения: rename работает и через Docker bind mount.
const stage = await fs.mkdtemp(path.join(output, '.bridge-runtime-'));
const content = path.join(stage, 'package');
try {
    await fs.mkdir(path.join(content, 'bin'), { recursive: true });
    for (const name of ['dist', 'package.json', 'package-lock.json']) await fs.cp(path.join(bridge, name), path.join(content, name), { recursive: true });
    const copiedManifest = JSON.parse(await fs.readFile(path.join(content, 'package.json'), 'utf8'));
    const copiedBuild = await verifyBridgeBuild(path.join(content, 'dist'), manifest.version);
    if (copiedManifest.version !== manifest.version || copiedBuild.buildId !== build.buildId) throw new Error('Сборка изменилась во время упаковки. Повторите упаковку неизменяемого кандидата.');
    await packageBridgeOpenCodeSdk({root, content, stage, target});
    const npm=npmCli();
    await withNpmBuildEnvironment(process.env, async ({env, args}) => {
        execFileSync(process.execPath, [npm, 'ci', '--omit=dev', '--include=optional', '--no-audit', '--no-fund', ...args], {
            cwd: content, stdio: 'inherit', env: {...env, PATH: path.dirname(process.execPath) + path.delimiter + env.PATH},
        });
    });
    await fs.rm(path.join(content, 'node_modules/.bin'), { recursive: true, force: true });
    const node = path.join(content, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
    await fs.copyFile(process.execPath, node); await fs.chmod(node, 0o755);
    const licenses = [path.resolve(path.dirname(process.execPath), '../LICENSE'), path.resolve(path.dirname(process.execPath), 'LICENSE')];
    const license = await Promise.all(licenses.map(async file => await fs.access(file).then(() => file, () => undefined)));
    if (!license.find(Boolean)) throw new Error('Не найден LICENSE распространяемого runtime Node.js.');
    await fs.copyFile(license.find(Boolean), path.join(content, 'bin/NODE-LICENSE'));
    let ragSupported = true;
    const probe = `const l=await import('@lancedb/lancedb');const db=await l.connect(${JSON.stringify(path.join(stage, 'native-test'))});const table=await db.createTable('self_test',[{id:'fixture'}]);if(await table.countRows()!==1)process.exit(1);`;
    try { execFileSync(node, ['--input-type=module', '-e', probe], { cwd: content, stdio: 'pipe' }); }
    catch {
        ragSupported = false;
        if (!(process.platform === 'darwin' && process.arch === 'x64')) throw new Error('Нативная LanceDB не загружается. Неполный пакет не опубликован.');
    }
    const probeEngine = await packageProbeEngine({ root, content, stage });
    const windowsJobHelper=await packageWindowsJobHelper({content});
    const metadata = { version: manifest.version, target, nodeVersion: process.versions.node, buildId: build.buildId, ragSupported, probeEngine,...(windowsJobHelper?{windowsJobHelper}:{}) };
    await fs.writeFile(path.join(content, 'runtime.json'), JSON.stringify(metadata, null, 2) + '\n');
    const name = `neurocenter-asset-sync-${target}-${manifest.version}.tgz`;
    const archive = path.join(stage, name);
    for (const file of await fs.readdir(content, { recursive: true })) {
        if ((await fs.lstat(path.join(content, file))).isSymbolicLink()) throw new Error('В runtime осталась ссылка: ' + file);
    }
    execFileSync('tar', ['-czf', archive, '-C', content, 'bin', 'dist', 'node_modules', 'package.json', 'package-lock.json', 'runtime.json'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    await verifyBridgeSdkArchive(archive, target);
    const digest = createHash('sha256'); for await (const chunk of createReadStream(archive)) digest.update(chunk);
    const sha256 = digest.digest('hex');
    await fs.rename(archive, path.join(output, name));
    await fs.writeFile(path.join(output, name + '.sha256'), sha256 + '\n');
    await fs.writeFile(path.join(output, name + '.json'), JSON.stringify({ ...metadata, sha256, bytes: (await fs.stat(path.join(output, name))).size }, null, 2) + '\n');
    console.log(JSON.stringify({ file: path.join(output, name), ...metadata, sha256 }));
} catch (error) {
    if (!(error instanceof SdkUnavailableError)) throw error;
    console.error(error.message); process.exitCode = SDK_UNAVAILABLE_EXIT_CODE;
} finally { await fs.rm(stage, { recursive: true, force: true }); }
