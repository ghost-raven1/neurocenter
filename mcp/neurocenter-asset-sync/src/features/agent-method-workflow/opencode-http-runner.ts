import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';

const limit = 1024 * 1024;
type TJsonObject = Record<string, unknown>;
const object = (value: unknown): value is TJsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;
type TRuntimeFailureCode = 'EXECUTION_FAILED' | 'OUTPUT_LIMIT' | 'TIMEOUT' | 'SELECTED_AGENT_NOT_READY';
class RuntimeFailure extends Error {
    code: TRuntimeFailureCode;
    constructor(code: TRuntimeFailureCode = 'EXECUTION_FAILED') {
        super(code);
        this.code = code;
    }
}
interface ISelectedRuntimeAgent {
    slug: string;
    mode: 'primary' | 'all';
    model: { providerID: string; modelID: string };
    /** FR-306: the agent's extension kit is proven by the on-disk overlay, never trusted from argv alone. */
    agentId?: string;
    extensions?: unknown[];
    overlay?: string;
}
function selectedRuntimeAgent(raw: string | undefined): ISelectedRuntimeAgent | undefined {
    if (raw === undefined) return;
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new RuntimeFailure('SELECTED_AGENT_NOT_READY');
    }
    if (
        !object(value) ||
        (value.agentId === undefined
            ? Object.keys(value).sort().join(',') !== 'mode,model,slug'
            : Object.keys(value).sort().join(',') !== 'agentId,extensions,mode,model,overlay,slug') ||
        typeof value.slug !== 'string' ||
        !/^nc-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug) ||
        !['primary', 'all'].includes(String(value.mode)) ||
        !object(value.model) ||
        Object.keys(value.model).sort().join(',') !== 'modelID,providerID' ||
        typeof value.model.providerID !== 'string' ||
        typeof value.model.modelID !== 'string' ||
        !value.model.providerID ||
        !value.model.modelID ||
        (value.agentId !== undefined &&
            (typeof value.agentId !== 'string' ||
                !agentIdPattern.test(value.agentId) ||
                typeof value.overlay !== 'string' ||
                value.overlay !== agentOverlayPath(value.agentId) ||
                !Array.isArray(value.extensions) ||
                value.extensions.length > 16))
    )
        throw new RuntimeFailure('SELECTED_AGENT_NOT_READY');
    return value as unknown as ISelectedRuntimeAgent;
}
// FR-306: the runner is executed directly by Node, so the kit re-verification stays self-contained (no local imports).
// The overlay contract mirrors agent-extensions.ts exactly: same key set, same sha256 payload and key order.
const agentIdPattern = /^agent-[a-z0-9][a-z0-9-]{0,120}$/;
const overlayShaPattern = /^[a-f0-9]{64}$/;
const agentOverlayPath = (agentId: string): string => '.nc/agents/' + agentId + '/kit.json';
const overlayKeys = [
    'agentId',
    'agentsManifestSha256',
    'extensions',
    'mcpOverride',
    'projectId',
    'schemaVersion',
    'sha256',
];
const extensionKeys = ['assetId', 'assetKind', 'manifest', 'origin', 'version'];
const extensionShape = (value: unknown): boolean =>
    object(value) &&
    extensionKeys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => extensionKeys.includes(key)) &&
    typeof value.assetId === 'string' &&
    !!value.assetId &&
    value.assetId.length <= 512 &&
    typeof value.assetKind === 'string' &&
    ['mcp', 'plugin', 'skill'].includes(value.assetKind) &&
    Number.isSafeInteger(value.version) &&
    Number(value.version) >= 1 &&
    typeof value.manifest === 'string' &&
    overlayShaPattern.test(value.manifest) &&
    typeof value.origin === 'string' &&
    ['approved', 'experimental'].includes(value.origin);
const mcpOverrideShape = (value: unknown): boolean =>
    value === null ||
    (object(value) &&
        Object.keys(value).length <= 64 &&
        Object.keys(value).every((key) => !!key && key.length <= 200) &&
        Object.values(value).every((entry) => object(entry)));
const canonical = (value: unknown): string =>
    Array.isArray(value)
        ? '[' + value.map(canonical).join(',') + ']'
        : object(value)
          ? '{' +
            Object.keys(value)
                .sort()
                .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
                .join(',') +
            '}'
          : JSON.stringify(value);
const overlayFingerprint = (stat: { dev: bigint; ino: bigint; size: bigint }): string =>
    [stat.dev, stat.ino, stat.size].join(':');
/** Re-reads the committed overlay with the same tamper-detection discipline as the local receipts. */
async function readOverlay(file: string): Promise<string> {
    try {
        const before = await fs.lstat(file, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.size > 65536n) throw new Error('shape');
        const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            const opened = await handle.stat({ bigint: true });
            if (!opened.isFile() || opened.size > 65536n || overlayFingerprint(opened) !== overlayFingerprint(before))
                throw new Error('changed');
            const bytes = Buffer.alloc(Number(opened.size));
            let length = 0;
            while (length < bytes.length) {
                const read = await handle.read(bytes, length, bytes.length - length, null);
                if (!read.bytesRead) break;
                length += read.bytesRead;
            }
            const after = await handle.stat({ bigint: true });
            const located = await fs.lstat(file, { bigint: true });
            if (
                BigInt(length) !== opened.size ||
                overlayFingerprint(after) !== overlayFingerprint(opened) ||
                !located.isFile() ||
                located.isSymbolicLink() ||
                overlayFingerprint(located) !== overlayFingerprint(opened)
            )
                throw new Error('changed');
            const text = bytes.subarray(0, length).toString('utf8');
            if (!Buffer.from(text).equals(bytes.subarray(0, length))) throw new Error('encoding');
            return text;
        } finally {
            await handle.close();
        }
    } catch {
        throw new RuntimeFailure('SELECTED_AGENT_NOT_READY');
    }
}
/**
 * FR-306: the committed overlay must be internally consistent (sha256) and match the argv kit exactly;
 * any drift is refused. Returns undefined when the committed kit is unprovable, the pre-computed mcp
 * isolation when the kit pins mcp servers, and null for a valid kit without mcp isolation.
 */
function overlayKit(raw: string, selected: ISelectedRuntimeAgent): Record<string, unknown> | null | undefined {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (
        !object(value) ||
        overlayKeys.some((key) => !Object.hasOwn(value, key)) ||
        Object.keys(value).some((key) => !overlayKeys.includes(key)) ||
        value.schemaVersion !== 1 ||
        typeof value.agentId !== 'string' ||
        value.agentId !== selected.agentId ||
        !agentIdPattern.test(value.agentId) ||
        typeof value.projectId !== 'string' ||
        !value.projectId ||
        value.projectId.length > 200 ||
        typeof value.agentsManifestSha256 !== 'string' ||
        !overlayShaPattern.test(value.agentsManifestSha256) ||
        !Array.isArray(value.extensions) ||
        value.extensions.length > 16 ||
        !value.extensions.every(extensionShape) ||
        !mcpOverrideShape(value.mcpOverride)
    )
        return undefined;
    const seen = new Set(value.extensions.map((entry) => String(entry.assetKind) + ':' + String(entry.assetId)));
    if (seen.size !== value.extensions.length) return undefined;
    const payload = {
        agentId: value.agentId,
        projectId: value.projectId,
        agentsManifestSha256: value.agentsManifestSha256,
        extensions: value.extensions,
        mcpOverride: value.mcpOverride,
    };
    if (
        typeof value.sha256 !== 'string' ||
        !overlayShaPattern.test(value.sha256) ||
        createHash('sha256').update(JSON.stringify(payload)).digest('hex') !== value.sha256 ||
        canonical(value.extensions) !== canonical(selected.extensions)
    )
        return undefined;
    return object(value.mcpOverride) ? value.mcpOverride : null;
}
/** The bridge's inline config is merged, never replaced; a corrupt inline config with a kit is refused. */
function inlineConfig(value: string | undefined): TJsonObject | null {
    if (!value) return {};
    try {
        const parsed: unknown = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as TJsonObject) : null;
    } catch {
        return null;
    }
}
/** Runtime introspection must resolve the explicitly selected primary agent and its compiled model before any inference. */
export function assertRuntimeAgent(value: unknown, selected: ISelectedRuntimeAgent): void {
    if (!Array.isArray(value)) throw new RuntimeFailure('SELECTED_AGENT_NOT_READY');
    const matches = value.filter((agent) => object(agent) && agent.name === selected.slug),
        agent = matches[0];
    if (
        matches.length !== 1 ||
        !object(agent) ||
        agent.mode !== selected.mode ||
        !object(agent.model) ||
        agent.model.providerID !== selected.model.providerID ||
        agent.model.modelID !== selected.model.modelID
    )
        throw new RuntimeFailure('SELECTED_AGENT_NOT_READY');
}

/** A successful HTTP response must contain the final completed assistant turn, not a tool-call or partial response. */
export function assertCompletedAssistant(value: unknown, session: string, selected?: ISelectedRuntimeAgent): void {
    if (!object(value) || !object(value.info) || !Array.isArray(value.parts)) throw new RuntimeFailure();
    const info = value.info;
    if (
        selected &&
        (info.agent !== selected.slug ||
            info.providerID !== selected.model.providerID ||
            info.modelID !== selected.model.modelID)
    )
        throw new RuntimeFailure('SELECTED_AGENT_NOT_READY');
    if (
        info.role !== 'assistant' ||
        info.sessionID !== session ||
        !object(info.time) ||
        !finite(info.time.completed) ||
        info.error !== undefined ||
        info.finish !== 'stop'
    )
        throw new RuntimeFailure();
    if (
        !value.parts.some(
            (part) => object(part) && part.type === 'text' && typeof part.text === 'string' && part.text.trim(),
        )
    )
        throw new RuntimeFailure();
    for (const part of value.parts) {
        if (!object(part) || part.sessionID !== session || part.messageID !== info.id) throw new RuntimeFailure();
        if (part.type === 'tool' && (!object(part.state) || part.state.status !== 'completed'))
            throw new RuntimeFailure();
        if (part.type === 'step-finish' && part.reason !== 'stop') throw new RuntimeFailure();
    }
}

async function boundedJson(response: Response): Promise<unknown> {
    if (!response.ok || !response.body) throw new RuntimeFailure();
    const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > limit) throw new RuntimeFailure('OUTPUT_LIMIT');
            chunks.push(next.value);
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } finally {
        await reader.cancel().catch(() => {});
    }
}

/** Standalone Node24 entry: its server and tools remain descendants of the bridge's durably owned process group. */
async function main(): Promise<void> {
    const [engine, root, prompt, selection] = process.argv.slice(3),
        selected = selectedRuntimeAgent(selection);
    if (
        !engine ||
        !root ||
        !path.isAbsolute(root) ||
        path.resolve(process.cwd()) !== path.resolve(root) ||
        !prompt ||
        Buffer.byteLength(prompt) > 96 * 1024
    )
        throw new RuntimeFailure();
    const controller = new AbortController(),
        password = randomBytes(32).toString('hex'),
        username = 'neurocenter-method';
    const timer = setTimeout(() => controller.abort(new RuntimeFailure('TIMEOUT')), 15 * 60 * 1000);
    const abort = () => controller.abort(new RuntimeFailure());
    process.once('SIGTERM', abort);
    process.once('SIGINT', abort);
    let server: ReturnType<typeof spawn> | undefined;
    let exited: Promise<void> | undefined;
    let failed: (() => void) | undefined;
    try {
        // FR-306: per-agent extension kit — overlay proven on disk, pre-computed mcp isolation applied to the serve config.
        // A kit that cannot be proven refuses the run before the engine starts; a proven kit without mcp servers
        // keeps the inline config untouched.
        let agentEnv: NodeJS.ProcessEnv = {};
        if (selected?.agentId) {
            const overlay = path.resolve(root, selected.overlay as string);
            if (!overlay.startsWith(path.resolve(root) + path.sep))
                throw new RuntimeFailure('SELECTED_AGENT_NOT_READY');
            const mcp = overlayKit(await readOverlay(overlay), selected);
            if (mcp === undefined) throw new RuntimeFailure('SELECTED_AGENT_NOT_READY');
            if (mcp) {
                const base = inlineConfig(process.env.OPENCODE_CONFIG_CONTENT);
                if (base === null) throw new RuntimeFailure('SELECTED_AGENT_NOT_READY');
                agentEnv = {
                    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...base, mcp }),
                    NC_AGENT_EXTENSION_OVERLAY: overlay,
                };
            } else {
                agentEnv = { NC_AGENT_EXTENSION_OVERLAY: overlay };
            }
        }
        server = spawn(engine, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
            cwd: root,
            env: {
                ...process.env,
                OPENCODE_SERVER_USERNAME: username,
                OPENCODE_SERVER_PASSWORD: password,
                ...agentEnv,
            },
            shell: false,
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const child = server;
        if (!child.stdout || !child.stderr) throw new RuntimeFailure();
        const stdout = child.stdout,
            stderr = child.stderr;
        exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
        let bytes = 0,
            tail = '';
        const observe = (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > limit) controller.abort(new RuntimeFailure('OUTPUT_LIMIT'));
            tail = (tail + chunk.toString('utf8')).slice(-8192);
        };
        stdout.on('data', observe);
        stderr.on('data', observe);
        failed = () => controller.abort(new RuntimeFailure());
        child.once('error', failed);
        child.once('exit', failed);
        const url = await new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => finish(new RuntimeFailure('TIMEOUT')), 15000);
            const ready = () => {
                const match = tail.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
                if (match) finish(undefined, match[1]);
            };
            const cancelled = () => finish(controller.signal.reason);
            const finish = (error?: unknown, value?: string) => {
                clearTimeout(timeout);
                stdout.off('data', ready);
                stderr.off('data', ready);
                controller.signal.removeEventListener('abort', cancelled);
                if (error) reject(error);
                else resolve(value!);
            };
            stdout.on('data', ready);
            stderr.on('data', ready);
            controller.signal.addEventListener('abort', cancelled, { once: true });
            if (controller.signal.aborted) cancelled();
            else ready();
        });
        const request = async (method: 'GET' | 'POST', route: string, value?: unknown) => {
            const target = new URL(route, url);
            target.searchParams.set('directory', root);
            return boundedJson(
                await fetch(target, {
                    method,
                    redirect: 'error',
                    signal: controller.signal,
                    headers: {
                        'content-type': 'application/json',
                        authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64'),
                    },
                    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
                }),
            );
        };
        if (selected) assertRuntimeAgent(await request('GET', '/agent'), selected);
        const permission = ['question', 'plan_enter', 'plan_exit'].map((permission) => ({
            permission,
            action: 'deny',
            pattern: '*',
        }));
        const session = await request('POST', '/session', { title: 'Neurocenter development workflow', permission });
        if (!object(session) || typeof session.id !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(session.id))
            throw new RuntimeFailure();
        const response = await request('POST', '/session/' + session.id + '/message', {
            ...(selected ? { agent: selected.slug, model: selected.model } : {}),
            parts: [{ type: 'text', text: prompt }],
        });
        assertCompletedAssistant(response, session.id, selected);
        controller.signal.throwIfAborted();
        // Only fixed metadata leaves this process. Model text, tools, server logs and credentials stay private.
        process.stdout.write(JSON.stringify({ type: 'agent_method_completed', protocol: 'opencode-http-v1' }) + '\n');
    } finally {
        // Refusals before the engine starts must not leak the abort timer or signal handlers.
        clearTimeout(timer);
        process.off('SIGTERM', abort);
        process.off('SIGINT', abort);
        if (server && exited) {
            const child = server;
            child.off('exit', failed!);
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
            const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
            try {
                await exited;
            } finally {
                clearTimeout(kill);
            }
        }
    }
}

if (process.argv[2] === '--agent-method-runtime')
    void main().catch((error) => {
        const code = error instanceof RuntimeFailure ? error.code : 'EXECUTION_FAILED';
        process.stdout.write(
            JSON.stringify({ type: 'agent_method_failed', protocol: 'opencode-http-v1', code }) + '\n',
        );
        process.exitCode = 1;
    });
