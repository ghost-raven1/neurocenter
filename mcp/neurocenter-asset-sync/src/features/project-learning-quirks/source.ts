import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeTarget, workspaceDirectory } from '../../bridge/workspace-paths.js';
import { readBoundedSnapshot } from '../../bridge/read-bounded.js';
import { normalizeQuirksLimits, parseQuirksJsonl, type QuirksSnapshot, type LearningQuirksLimits } from './contract.js';

const configPaths = ['opencode-rag.json', '.opencode/opencode-rag.json', '.opencode/rag.json'];
const changed = () =>
    new Error('Источник кварков или конфигурация RAG изменились. Дождитесь окончания записи и повторите сбор.');
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
interface Configuration {
    file: string | null;
    sha256: string | null;
    store: string;
}
/** This reader deliberately avoids locateStore: recovery and LanceDB are outside a read-only import. */
async function configuration(root: string): Promise<Configuration> {
    for (const relative of configPaths) {
        const file = await safeTarget(root, relative);
        try {
            await fs.lstat(file);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
        }
        const snapshot = await readBoundedSnapshot(file, 256 * 1024),
            raw = snapshot.bytes.toString('utf8');
        if (!Buffer.from(raw).equals(snapshot.bytes)) throw changed();
        let config: { vectorStore?: { path?: unknown } };
        try {
            config = JSON.parse(raw);
            if (!config || typeof config !== 'object' || Array.isArray(config)) throw changed();
        } catch {
            throw changed();
        }
        if (
            config.vectorStore !== undefined &&
            (!config.vectorStore || typeof config.vectorStore !== 'object' || Array.isArray(config.vectorStore))
        )
            throw changed();
        const configured = config.vectorStore?.path;
        if (
            configured !== undefined &&
            (typeof configured !== 'string' || !configured.trim() || configured.startsWith('memory:'))
        )
            throw changed();
        return {
            file,
            sha256: digest(snapshot.bytes),
            store:
                typeof configured === 'string' ? path.resolve(root, configured) : path.join(root, '.opencode/rag_db'),
        };
    }
    return { file: null, sha256: null, store: path.join(root, '.opencode/rag_db') };
}
function relative(root: string, file: string) {
    const value = path.relative(root, file).split(path.sep).join('/');
    if (!value || value.startsWith('../') || path.isAbsolute(value))
        throw new Error('Источник кварков должен находиться внутри подтверждённой папки проекта.');
    return value;
}
/** Whole-source validation and two stable reads prevent partial, missing and torn sources from becoming empty success. */
export async function readQuirksSource(
    root: string,
    authorize: () => Promise<void>,
    settings?: Partial<LearningQuirksLimits>,
): Promise<QuirksSnapshot & { jsonl: string; assertCurrent: () => Promise<void> }> {
    const limits = normalizeQuirksLimits(settings);
    await authorize();
    const directory = await workspaceDirectory(root),
        config = await configuration(root);
    const sourceRelative = relative(root, path.join(config.store, 'quirks.jsonl'));
    const source = await safeTarget(root, sourceRelative),
        budget = Math.min(limits.bytes, limits.totalBytes);
    if ((await fs.lstat(source)).size > budget)
        throw Object.assign(
            new Error('Источник кварков превышает квоту чтения. Уменьшите источник или измените квоту в настройках.'),
            { code: 'LEARNING_QUIRKS_QUOTA', limit: 'bytes' },
        );
    const snapshot = await readBoundedSnapshot(source, budget);
    const jsonl = snapshot.bytes.toString('utf8');
    if (!Buffer.from(jsonl).equals(snapshot.bytes)) throw changed();
    const checked = parseQuirksJsonl(jsonl, limits);
    const assertCurrent = async () => {
        await authorize();
        const currentDirectory = await workspaceDirectory(root),
            currentConfig = await configuration(root);
        if (
            JSON.stringify(currentDirectory) !== JSON.stringify(directory) ||
            JSON.stringify(currentConfig) !== JSON.stringify(config) ||
            (await safeTarget(root, sourceRelative)) !== source
        )
            throw changed();
        const current = await readBoundedSnapshot(source, Math.min(limits.bytes, limits.totalBytes));
        if (current.fingerprint !== snapshot.fingerprint || !current.bytes.equals(snapshot.bytes)) throw changed();
    };
    await assertCurrent();
    return { ...checked, jsonl, assertCurrent };
}
