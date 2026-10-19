import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { packRuntime } from '../pack.mjs';
import runtime from '../../../services/shared/runtime-artifacts.cjs';

test('USTAR сохраняет бинарные байты, длинные пути и права; одинаковые файлы дают одинаковый SHA', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-pack-'));
    try {
        const directory = path.join(root, 'source');
        const entrypoint = 'node_modules/' + 'dependency-name/'.repeat(7) + 'entrypoint.mjs';
        await fs.mkdir(path.dirname(path.join(directory, entrypoint)), { recursive: true });
        await fs.mkdir(path.join(directory, 'bin'));
        await fs.writeFile(path.join(directory, entrypoint), 'export default {}');
        const binary = Buffer.from([0, 1, 255, 128]);
        await fs.writeFile(path.join(directory, 'bin/native'), binary);
        const config = { directory, target: 'darwin-arm64', entrypoint, executables: ['bin/native'] };
        const first = await packRuntime({ ...config, archivePath: path.join(root, 'one.tar.gz') });
        const second = await packRuntime({ ...config, archivePath: path.join(root, 'two.tar.gz') });
        assert.deepEqual(first, second);
        const destination = path.join(root, 'unpacked');
        const files = await runtime.inspectRuntimeArchive(path.join(root, 'one.tar.gz'), first, { destination });
        assert.deepEqual(await fs.readFile(path.join(destination, 'bin/native')), binary);
        assert.equal(files.find(file => file.path === 'bin/native').executable, true);
        assert.equal(files.find(file => file.path === entrypoint).executable, false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Поставка отклоняет символические ссылки и непереносимые имена до создания архива', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-pack-'));
    try {
        const directory = path.join(root, 'source'); await fs.mkdir(directory);
        const entrypoint = 'entrypoint.mjs'; await fs.writeFile(path.join(directory, entrypoint), 'export default {}');
        await fs.symlink(entrypoint, path.join(directory, 'alias.mjs'));
        const config = { directory, target: 'darwin-arm64', entrypoint, archivePath: path.join(root, 'one.tar.gz') };
        await assert.rejects(packRuntime(config), /Ссылки/);
        await fs.unlink(path.join(directory, 'alias.mjs'));
        await fs.writeFile(path.join(directory, 'bad:name'), 'x');
        await assert.rejects(packRuntime(config), /Непереносимый путь/);
        await assert.rejects(fs.stat(config.archivePath), { code: 'ENOENT' });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
