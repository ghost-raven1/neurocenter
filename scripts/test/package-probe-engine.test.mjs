import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { packageProbeEngine, probeArchiveName, probeVersion } from '../bridge-runtime-probe.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const musl = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-probe-package-')); roots.push(root);
    const content = path.join(root, 'output'); const stage = path.join(root, 'stage');
    await fs.mkdir(content); await fs.mkdir(stage); await fs.mkdir(path.join(root, 'bridge-dist/opencode'), { recursive: true });
    return { root, content, stage, archive: path.join(root, 'bridge-dist/opencode', `${probeArchiveName(process.platform, process.arch, musl)}-${probeVersion}.tgz`) };
}
test('Матрица выбирает ровно восемь закреплённых baseline/musl артефактов', () => {
    assert.deepEqual([
        probeArchiveName('darwin', 'arm64'), probeArchiveName('darwin', 'x64'),
        probeArchiveName('linux', 'arm64'), probeArchiveName('linux', 'arm64', true),
        probeArchiveName('linux', 'x64'), probeArchiveName('linux', 'x64', true),
        probeArchiveName('win32', 'arm64'), probeArchiveName('win32', 'x64'),
    ], ['opencode-darwin-arm64', 'opencode-darwin-x64-baseline', 'opencode-linux-arm64', 'opencode-linux-arm64-musl',
        'opencode-linux-x64-baseline', 'opencode-linux-x64-baseline-musl', 'opencode-windows-arm64', 'opencode-windows-x64-baseline']);
    assert.throws(() => probeArchiveName('darwin', 'arm64', true)); assert.throws(() => probeArchiveName('linux', 'ia32'));
});
test('Подменённый archive SHA отвергается до извлечения или исполнения', async () => {
    const f = await fixture(); await fs.writeFile(f.archive, 'Подмена'); await fs.writeFile(f.archive + '.sha256', '0'.repeat(64));
    await assert.rejects(packageProbeEngine(f), /SHA/);
    assert.deepEqual(await fs.readdir(f.content), []);
});
test('Архив другой версии отвергается даже с согласованным sidecar SHA', async () => {
    const f = await fixture(); const directory = path.join(f.stage, 'source/package'); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: probeArchiveName(process.platform, process.arch, musl), version: '1.14.47' }));
    execFileSync('tar', ['-czf', f.archive, '-C', path.dirname(directory), 'package']);
    await fs.writeFile(f.archive + '.sha256', sha(await fs.readFile(f.archive)));
    await assert.rejects(packageProbeEngine(f), /Версия/);
    assert.deepEqual(await fs.readdir(f.content), []);
});
test('Native pinned binary копируется, подписывается только в staging и сообщает exact SHA', { skip: process.env.NEUROCENTER_TEST_PACKAGE_PROBE !== '1' }, async () => {
    const f = await fixture(); const original = path.join(repository, 'bridge-dist/opencode', path.basename(f.archive));
    const archiveBytes = await fs.readFile(original); const checksum = await fs.readFile(original + '.sha256');
    await fs.writeFile(f.archive, archiveBytes); await fs.writeFile(f.archive + '.sha256', checksum);
    const metadata = await packageProbeEngine(f);
    const binary = path.join(f.content, metadata.file);
    assert.deepEqual(metadata, { version: '1.14.48', sha256: sha(await fs.readFile(binary)), file: process.platform === 'win32' ? 'bin/opencode-probe.exe' : 'bin/opencode-probe' });
    assert.equal(await fs.readFile(original).then(sha), sha(archiveBytes));
    assert.deepEqual(await fs.readdir(f.content), ['bin']);
    assert.deepEqual(await fs.readdir(path.join(f.content, 'bin')), [path.basename(binary)]);
    assert.equal((await fs.lstat(binary)).isSymbolicLink(), false);
    await assert.rejects(fs.access(path.join(f.stage, 'probe-engine-home')), { code: 'ENOENT' });
});
