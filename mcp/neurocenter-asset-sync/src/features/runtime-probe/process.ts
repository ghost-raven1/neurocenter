import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ProbeError } from './model.js';
import { windowsJobHelper } from './windows-job.js';

/** Один общий срок включает авторизацию, handshake, чтение и завершение собственных процессов. */
export class ProbeScope {
    readonly controller = new AbortController();
    readonly deadline: number;
    private readonly children = new Set<ChildProcessWithoutNullStreams>();
    private readonly timer: NodeJS.Timeout;

    constructor(milliseconds=59_000){
        this.deadline=Date.now()+milliseconds;
        this.timer=setTimeout(()=>this.controller.abort(),milliseconds);
    }

    remaining(): number {
        const value = this.deadline - Date.now();
        if (value <= 0 || this.controller.signal.aborted) { throw new ProbeError('failed', 'timeout'); }
        return value;
    }
    async wait<T>(promise: Promise<T>): Promise<T> {
        this.remaining();
        let listener: () => void = () => {};
        const aborted = new Promise<never>((_, reject) => {
            listener = () => reject(new ProbeError('failed', 'timeout'));
            this.controller.signal.addEventListener('abort', listener, { once: true });
        });
        try { return await Promise.race([promise, aborted]); }
        finally { this.controller.signal.removeEventListener('abort', listener); }
    }
    /** Отозванные права проверяются перед каждым новым действием и финальным результатом. */
    async authorize(check: () => Promise<void>): Promise<void> {
        try { await this.wait(check()); }
        catch (error) { if (error instanceof ProbeError) { throw error; } throw new ProbeError('not_checked', 'authorization-denied'); }
    }
    async start(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, authorize: () => Promise<void>): Promise<ChildProcessWithoutNullStreams> {
        await this.authorize(authorize);
        this.remaining();
        const helper = process.platform === 'win32' ? await windowsJobHelper() : undefined;
        if (process.platform === 'win32' && !helper) {throw new ProbeError('unsupported','unsupported-platform');}
        const child = spawn(helper ?? command, helper ? ['--parent-pid',String(process.pid),'--',command,...args] : args,
            { cwd, env, detached: process.platform !== 'win32', shell: false, windowsHide:true, stdio: ['pipe', 'pipe', 'pipe'] });
        this.children.add(child);
        child.stdin.on('error', () => {});
        await this.wait(new Promise<void>((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', () => reject(new ProbeError('unsupported', 'runtime-unavailable')));
        }));
        return child;
    }
    stop(child: ChildProcessWithoutNullStreams): void {
        // Только группа, созданная нами через detached; чужие PID никогда не перечисляются.
        if (child.pid) { try {if (process.platform === 'win32') {child.kill('SIGKILL');} else {process.kill(-child.pid, 'SIGKILL');}} catch {} }
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        this.children.delete(child);
    }
    async command(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, authorize: () => Promise<void>, capture = false): Promise<{ code: number | null; stdout: string }> {
        const child = await this.start(command, args, cwd, env, authorize);
        let bytes = 0;
        const chunks: Buffer[] = [];
        try {
            return await this.wait(new Promise((resolve, reject) => {
                const receive = (chunk: Buffer, stdout: boolean): void => {
                    bytes += chunk.length;
                    if (bytes > 256 * 1024) { this.stop(child); reject(new ProbeError('failed', 'output-limit')); }
                    else if (stdout && capture) { chunks.push(chunk); }
                };
                child.stdout.on('data', chunk => receive(chunk, true));
                child.stderr.on('data', chunk => receive(chunk, false));
                child.once('close', code => resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') }));
                child.once('error', () => reject(new ProbeError('unsupported', 'runtime-unavailable')));
            }));
        } finally { this.stop(child); }
    }
    close(): void {
        clearTimeout(this.timer);
        this.controller.abort();
        for (const child of this.children) { this.stop(child); }
    }
}
