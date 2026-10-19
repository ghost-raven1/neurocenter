import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const probeVersion = '1.14.48';
/** Имена npm-артефактов используют baseline для x64 и отдельный musl только на Linux. */
export function probeArchiveName(platform = process.platform, arch = process.arch, musl = false) {
    const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform];
    if (!os || !['x64', 'arm64'].includes(arch) || musl && platform !== 'linux') throw new Error('Unsupported probe target');
    return `opencode-${os}-${arch}${arch === 'x64' ? '-baseline' : ''}${musl ? '-musl' : ''}`;
}
async function digest(file) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

/** Включает только закреплённый binary; исходный архив и личный профиль никогда не изменяются. */
export async function packageProbeEngine({ root, content, stage }) {
    const musl = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
    const name = probeArchiveName(process.platform, process.arch, musl);
    const archive = path.join(root, 'bridge-dist/opencode', `${name}-${probeVersion}.tgz`);
    const checksumFile = archive + '.sha256';
    const checksumStat = await fs.lstat(checksumFile);
    const archiveStat = await fs.lstat(archive);
    if (!checksumStat.isFile() || checksumStat.size > 1024 || !archiveStat.isFile() || archiveStat.size > 128 * 1024 * 1024) throw new Error('Некорректный закреплённый архив OpenCode.');
    const expected = (await fs.readFile(checksumFile, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(expected) || await digest(archive) !== expected) throw new Error('SHA закреплённого OpenCode не совпадает.');
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8', maxBuffer: 16 * 1024 }));
    if (manifest.name !== name || manifest.version !== probeVersion) throw new Error('Версия закреплённого OpenCode не совпадает.');
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const file = `bin/opencode-probe${suffix}`;
    const binary = path.join(content, file);
    const home = path.join(stage, 'probe-engine-home');
    await fs.mkdir(path.dirname(binary), { recursive: true });
    try {
        // tar пишет только stdout: ссылки и посторонние entries не распаковываются в файловую систему.
        const bytes = execFileSync('tar', ['-xOzf', archive, `package/bin/opencode${suffix}`], { maxBuffer: 256 * 1024 * 1024 });
        await fs.writeFile(binary, bytes, { mode: 0o755, flag: 'wx' });
        if (process.platform === 'darwin') execFileSync('codesign', ['--force', '--sign', '-', binary], { stdio: 'pipe', timeout: 30_000, killSignal: 'SIGKILL' });
        await fs.mkdir(home, { recursive: true, mode: 0o700 });
        const version = execFileSync(binary, ['--version'], {
            cwd: home, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024,
            env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
                XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'),
                PATH: '', TERM: 'dumb', NO_COLOR: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
                OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(home, 'managed'),
                ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) },
        }).trim();
        if (version !== probeVersion) throw new Error('Закреплённый binary сообщает другую версию OpenCode.');
        return { version: probeVersion, sha256: await digest(binary), file };
    } catch (error) { await fs.rm(binary, { force: true }); throw error; }
    finally { await fs.rm(home, { recursive: true, force: true }); }
}
