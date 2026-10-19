import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { hash } from '../src/bridge/state.js';
import { canonical, type Package } from '../src/bridge/package.js';
import { bindProject, setRoot } from '../src/bridge/workspace.js';

/** Полный пакет и изолированные пути для проверок без пользовательских файлов. */
export function packageFixture(kind = 'skill', version = 1): Package {
    const plugin = {
        id: 'common/removal-test',
        name: 'removal-test',
        kind,
        version,
    };
    const config =
        kind === 'skill' ? null : { command: 'node', entrypoint: 'index.mjs' };
    const files = [
        {
            path: kind === 'skill' ? 'SKILL.md' : 'index.mjs',
            content: 'Тестовая версия ' + version,
        },
    ].map((file) => ({
        ...file,
        size: Buffer.byteLength(file.content),
        sha256: hash(file.content),
    }));
    const sha256 = hash(
        JSON.stringify(
            canonical({
                schemaVersion: 2,
                plugin,
                config,
                files: files.map(({ path, size, sha256 }) => ({
                    path,
                    size,
                    sha256,
                })),
            }),
        ),
    );
    return {
        schemaVersion: 2,
        plugin,
        config,
        files,
        manifest: { sha256, filesCount: files.length },
    };
}
export async function workspaceFixture() {
    const temporary = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-removal-')),
    );
    vi.stubEnv('NEUROCENTER_BRIDGE_HOME', path.join(temporary, 'private'));
    vi.stubEnv('NEUROCENTER_URL', 'http://localhost:5173');
    const root = path.join(temporary, 'проекты', 'мой проект');
    await fs.mkdir(root, { recursive: true });
    await setRoot(path.dirname(root));
    await bindProject('test-project', path.basename(root));
    return { temporary, root };
}
