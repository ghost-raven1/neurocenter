import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Hosted browser processes belong to one detached group; shutdown never searches or kills unrelated PIDs. */
export class OwnedHostedStdio implements Transport {
    onmessage?: (message: JSONRPCMessage) => void;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    private child?: ChildProcessWithoutNullStreams;
    private readonly buffer = new ReadBuffer({ maxBufferSize: 1024 * 1024 });
    private bytes = 0;
    private closing?: Promise<void>;
    constructor(
        private readonly command: string,
        private readonly args: string[],
        private readonly cwd: string,
        private readonly env: Record<string, string>,
    ) {}
    async start() {
        if (process.platform === 'win32')
            throw new Error('Серверный хост MCP требует управляемую группу процессов Linux или macOS.');
        if (this.child) throw new Error('Транспорт MCP уже запущен.');
        const child = spawn(this.command, this.args, {
            cwd: this.cwd,
            env: this.env,
            detached: true,
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child = child;
        child.stdin.on('error', () => {});
        const fail = (error: Error) => {
            this.onerror?.(error);
            void this.close();
        };
        const receive = (chunk: Buffer, stdout: boolean) => {
            this.bytes += chunk.byteLength;
            if (this.bytes > 8 * 1024 * 1024) {
                fail(new Error('MCP превысил предел транспорта.'));
                return;
            }
            if (stdout)
                try {
                    this.buffer.append(chunk);
                    for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage())
                        this.onmessage?.(message);
                } catch {
                    fail(new Error('MCP вернул некорректное сообщение.'));
                }
        };
        child.stdout.on('data', (chunk) => receive(chunk, true));
        child.stderr.on('data', (chunk) => receive(chunk, false));
        child.once('close', () => this.onclose?.());
        child.once('error', () => fail(new Error('MCP не удалось запустить.')));
        await new Promise<void>((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
        });
    }
    async send(message: JSONRPCMessage) {
        if (!this.child?.stdin.writable) throw new Error('MCP отключён.');
        const child = this.child;
        await new Promise<void>((resolve, reject) =>
            child.stdin.write(serializeMessage(message), (error) => (error ? reject(error) : resolve())),
        );
    }
    async close() {
        if (this.closing) return this.closing;
        const child = this.child;
        this.child = undefined;
        this.buffer.clear();
        if (!child) return;
        this.closing = (async () => {
            if (child.pid) {
                try {
                    process.kill(-child.pid, 'SIGTERM');
                } catch {}
            }
            await Promise.race([
                new Promise<void>((resolve) => {
                    if (child.exitCode !== null) resolve();
                    else child.once('close', () => resolve());
                }),
                new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, 500);
                    timer.unref();
                }),
            ]);
            // Even when the parent has exited, its owned browser descendants can still hold the group.
            if (child.pid) {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch {}
            }
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
        })();
        return this.closing;
    }
}
