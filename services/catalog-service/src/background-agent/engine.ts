import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * FR-305 (agt-07, OQ-2): the server agent executes the pinned OpenCode runtime from the
 * operator-provisioned autonomous package — `bin/opencode-probe` with the server-fixed version
 * (1.14.48, the same single version as the device bridge,
 * mcp/neurocenter-asset-sync/src/bridge/runtime-engine.ts). The global opencode from PATH is never
 * used: a missing or corrupt package is an explicit prerequisite failure at startup (I/O row 3:
 * «нет компонента → явная ошибка»), not a fallback.
 */
export const BACKGROUND_AGENT_OPENCODE_VERSION = '1.14.48';

/** Startup prerequisite failure: the message is a fixed classifier (AD-O8), no paths or values. */
export class BackgroundEngineError extends Error {}

/** The validated engine the runtime must spawn (IAgentRuntimeOptions.engine). */
export interface IBackgroundAgentEngine {
    /** Absolute path of the validated engine binary. */
    path: string;
    version: typeof BACKGROUND_AGENT_OPENCODE_VERSION;
    sha256: string;
}

const HEX64 = /^[a-f0-9]{64}$/;
const probeFile = (): string => (process.platform === 'win32' ? 'bin/opencode-probe.exe' : 'bin/opencode-probe');
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_ENGINE_BYTES = 256 * 1024 * 1024;

/**
 * The root of the operator-provisioned autonomous package (the named compose volume
 * `background-agent-runtime`, mounted read-only). Missing/blank → explicit startup failure.
 */
export function backgroundAgentRuntimeRoot(): string {
    const root = process.env.BACKGROUND_AGENT_RUNTIME_ROOT;
    if (typeof root !== 'string' || !root.trim())
        throw new BackgroundEngineError(
            'BACKGROUND_AGENT_RUNTIME_ROOT не задан: корень автономного пакета с bin/opencode-probe обязателен для фонового агента.',
        );
    return path.resolve(root);
}

/** Bounded read of a text file (metadata only); size/shape problems collapse to one classifier. */
async function readBoundedUtf8(file: string, maxBytes: number): Promise<string | null> {
    try {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > maxBytes) return null;
        return await fs.readFile(file, 'utf8');
    } catch {
        return null;
    }
}

/** Streaming sha256 of the engine binary (bounded); a truncated stream is a mismatch, not a partial hash. */
function sha256Of(file: string, maxBytes: number): Promise<string | null> {
    return new Promise((resolve) => {
        const hash = createHash('sha256');
        let bytes = 0;
        let failed = false;
        const stream = createReadStream(file);
        stream.on('data', (chunk: string | Buffer) => {
            if (failed) return;
            bytes += chunk.length;
            if (bytes > maxBytes) {
                failed = true;
                stream.destroy();
                resolve(null);
                return;
            }
            hash.update(chunk);
        });
        stream.on('error', () => {
            if (!failed) {
                failed = true;
                resolve(null);
            }
        });
        stream.on('end', () => {
            if (!failed) resolve(hash.digest('hex'));
        });
    });
}

/**
 * Validate the autonomous package engine: runtime.json → probeEngine {file, version, sha256} plus the
 * real hash of the binary itself. Any mismatch (missing package, corrupt metadata, version drift,
 * hash drift) is an explicit BackgroundEngineError — the run never starts on an unpinned runtime.
 */
export async function assertBackgroundAgentEngine(
    root: string = backgroundAgentRuntimeRoot(),
): Promise<IBackgroundAgentEngine> {
    const metadata = await readBoundedUtf8(path.join(root, 'runtime.json'), MAX_METADATA_BYTES);
    if (metadata === null)
        throw new BackgroundEngineError(
            'Автономный пакет фонового агента недоступен: runtime.json не найден или повреждён.',
        );
    let parsed: { probeEngine?: { file?: unknown; version?: unknown; sha256?: unknown } };
    try {
        parsed = JSON.parse(metadata);
    } catch {
        throw new BackgroundEngineError('Автономный пакет фонового агента недоступен: runtime.json повреждён.');
    }
    const engine = parsed?.probeEngine;
    const expectedFile = probeFile();
    if (
        engine?.file !== expectedFile ||
        engine.version !== BACKGROUND_AGENT_OPENCODE_VERSION ||
        typeof engine.sha256 !== 'string' ||
        !HEX64.test(engine.sha256)
    )
        throw new BackgroundEngineError(
            `Автономный пакет не соответствует пину: ожидается ${expectedFile} OpenCode ${BACKGROUND_AGENT_OPENCODE_VERSION} с sha256.`,
        );
    const binary = path.join(root, expectedFile);
    const actual = await sha256Of(binary, MAX_ENGINE_BYTES);
    if (actual !== engine.sha256)
        throw new BackgroundEngineError(
            'Движок bin/opencode-probe не соответствует закреплённому sha256 автономного пакета.',
        );
    return { path: binary, version: BACKGROUND_AGENT_OPENCODE_VERSION, sha256: engine.sha256 };
}
