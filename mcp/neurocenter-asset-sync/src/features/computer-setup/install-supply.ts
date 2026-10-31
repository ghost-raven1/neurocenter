import fs from 'node:fs/promises';
import path from 'node:path';
import { readBoundedSnapshot } from '../../bridge/read-bounded.js';
import { bridgeBuildId } from '../../bridge/protocol.js';
import { normalizeOpenCodeInstallSupply, type OpenCodeInstallSupply } from './install-contract.js';

/** Only the binary embedded in this installed, pinned bridge can become a user CLI. */
export async function bundledOpenCodeInstallSource(
    runtimeRoot = path.dirname(path.dirname(process.execPath)),
): Promise<{ source: OpenCodeInstallSupply; file: string }> {
    const root = await fs.realpath(runtimeRoot);
    if (root !== path.resolve(runtimeRoot)) throw Error('Недоступна закреплённая поставка OpenCode.');
    const value = JSON.parse(
        (await readBoundedSnapshot(path.join(root, 'runtime.json'), 64 * 1024)).bytes.toString('utf8'),
    ) as {
        buildId?: unknown;
        target?: unknown;
        probeEngine?: { file?: unknown; version?: unknown; sha256?: unknown };
    };
    const source = normalizeOpenCodeInstallSupply({
        buildId: value.buildId,
        target: value.target,
        version: value.probeEngine?.version,
        sha256: value.probeEngine?.sha256,
    });
    if (value.probeEngine?.file !== 'bin/opencode-probe') throw Error('Недоступна закреплённая поставка OpenCode.');
    const directory = path.join(root, 'bin'),
        stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(directory)) !== directory)
        throw Error('Недоступна закреплённая поставка OpenCode.');
    return { source, file: path.join(root, 'bin/opencode-probe') };
}

/** A source/degraded report cannot advertise a guessed or foreign install package. */
export async function openCodeInstallSupply(): Promise<OpenCodeInstallSupply | undefined> {
    try {
        const { source } = await bundledOpenCodeInstallSource();
        return source.buildId === (await bridgeBuildId()) ? source : undefined;
    } catch {
        return undefined;
    }
}
