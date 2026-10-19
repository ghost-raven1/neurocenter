import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const repository = 'https://github.com/zcaceres/fetch-mcp';
const commit = '1ddb1a59cb09a2d38e759f2d7a97829680cbe514';
const entrypoint = 'src/index.ts';
const sourceSha256 = '72a37b4a3d371948d0075184b299fc5d62557ee74f27195f5c57d4214811b4be';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Известный Fetch объявляет ресурсы без обработчика; исправляется только проверенный исходник. */
export async function applyFetchCompatibility(source, directory) {
    if (source.url !== repository || source.commit !== commit || source.entrypoint !== entrypoint
        || source.subdirectory || source.runtimeSource) { return undefined; }
    const filename = path.join(directory, entrypoint);
    const original = await fs.readFile(filename);
    if (hash(original) !== sourceSha256) { throw new Error('Закреплённый исходник Fetch не совпал с ожидаемой SHA-256; исправление не применено.'); }
    const patched = original.toString('utf8').replace('      resources: {},\n', '');
    await fs.writeFile(filename, patched);
    return { id: 'fetch-tools-only-v1', path: entrypoint, sourceSha256, patchedSha256: hash(patched) };
}
