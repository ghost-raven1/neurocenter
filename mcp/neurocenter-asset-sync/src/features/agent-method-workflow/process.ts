import { startRoleMcpProcess, type RoleMcpProcessJournal } from '../system-role-mcp/owned-process.js';
import type { AgentMethodFailureCode } from './contract.js';

export class MethodExecutionError extends Error {
    constructor(readonly code: AgentMethodFailureCode) {
        super('Локальный цикл разработки не завершён: ' + code);
    }
}
export type MethodCommandResult = { code: number | null; signal: string | null; stdout: string };
export type MethodCommandRunner = (command: string, args: string[], capture?: boolean) => Promise<MethodCommandResult>;

/** Only the owned wrapper receives argv; stdout is bounded and stays local unless it is parsed metadata. */
export async function runMethodCommand(
    command: string,
    args: string[],
    root: string,
    env: NodeJS.ProcessEnv,
    authorize: () => Promise<void>,
    signal: AbortSignal,
    journal: RoleMcpProcessJournal,
    capture = false,
): Promise<MethodCommandResult> {
    const process = await startRoleMcpProcess(command, args, root, env, authorize, signal, journal);
    // CLI run commands consume piped input before acting. There is no interactive/MCP stdin in this execution lane.
    process.child.stdin.end();
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= process.close());
    let bytes = 0,
        overflow = false;
    const chunks: Buffer[] = [];
    const receive = (chunk: Buffer, stdout: boolean) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
            overflow = true;
            void close().catch(() => {});
        } else if (capture && stdout) chunks.push(chunk);
    };
    process.child.stdout.on('data', (chunk) => receive(Buffer.from(chunk), true));
    process.child.stderr.on('data', (chunk) => receive(Buffer.from(chunk), false));
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
        abort = () => {
            void close().then(() => reject(signal.reason ?? new MethodExecutionError('CANCELLED')), reject);
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    });
    try {
        const result = await Promise.race([process.execution, cancelled]);
        await close();
        if (overflow) throw new MethodExecutionError('OUTPUT_LIMIT');
        signal.throwIfAborted();
        return { ...result, stdout: capture ? Buffer.concat(chunks).toString('utf8') : '' };
    } finally {
        signal.removeEventListener('abort', abort);
        await close();
    }
}
