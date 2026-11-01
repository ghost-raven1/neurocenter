import { BRIDGE_SHARED_RUNTIME_FILES } from './runtime-shared-files.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeRuntimeBootstraps } from './runtime-bootstraps.mjs';

// Архив не должен сохранять удалённые инструменты из предыдущей сборки dist.
const root = fileURLToPath(new URL('../', import.meta.url));
const stage = await fs.mkdtemp(path.join(root, '.bridge-build-'));
const destination = path.join(root, 'dist');
const previous = path.join(stage, 'previous');
let moved = false;
try {
    execFileSync(
        process.execPath,
        [
            path.join(root, 'node_modules/typescript/bin/tsc'),
            '-p',
            path.join(root, 'tsconfig.json'),
            '--outDir',
            path.join(stage, 'dist'),
        ],
        { cwd: root, stdio: 'inherit' },
    );
    await fs.mkdir(path.join(stage, 'dist/shared'), { recursive: true });
    for (const name of BRIDGE_SHARED_RUNTIME_FILES) {
        await fs.copyFile(path.join(root, '../../services/shared', name), path.join(stage, 'dist/shared', name));
    }
    // Runtime dependencies also identify the build: an SDK update must refresh an installed worker.
    const adapterFiles = ['vendor/ollama-runtime/package.json', 'vendor/ollama-runtime/index.js', 'package-lock.json'];
    const adapter = createHash('sha256');
    for (const file of adapterFiles) {
        adapter.update(file + '\0');
        adapter.update(await fs.readFile(path.join(root, file)));
    }
    await fs.writeFile(
        path.join(stage, 'dist/shared/ollama-runtime.json'),
        JSON.stringify({ sourceSha256: adapter.digest('hex') }) + '\n',
    );
    await writeRuntimeBootstraps(path.join(stage, 'dist'));
    const digest = createHash('sha256');
    const files = (await fs.readdir(path.join(stage, 'dist'), { recursive: true })).sort();
    for (const file of files) {
        const full = path.join(stage, 'dist', file);
        if ((await fs.stat(full)).isFile()) {
            digest.update(file.split(path.sep).join('/') + '\0');
            digest.update(await fs.readFile(full));
        }
    }
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    await fs.writeFile(
        path.join(stage, 'dist/build.json'),
        JSON.stringify({ version: manifest.version, buildId: digest.digest('hex') }) + '\n',
    );
    try {
        await fs.rename(destination, previous);
        moved = true;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    try {
        await fs.rename(path.join(stage, 'dist'), destination);
    } catch (error) {
        if (moved) await fs.rename(previous, destination);
        throw error;
    }
} finally {
    await fs.rm(stage, { recursive: true, force: true });
}
