import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { ProbeError } from './model.js';
import type { ProbeScope } from './process.js';

/** SDK transport с собственной process group; стандартный SDK transport завершает только родительский PID. */
export class ProbeStdioTransport implements Transport {
    failure?: ProbeError;
    onmessage?: (message: JSONRPCMessage) => void;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    private child?: ChildProcessWithoutNullStreams;
    private readonly buffer = new ReadBuffer({ maxBufferSize: 1024 * 1024 });
    private total = 0;

    constructor(
        private readonly scope: ProbeScope,
        private readonly command: string,
        private readonly args: string[],
        private readonly cwd: string,
        private readonly env: NodeJS.ProcessEnv,
        private readonly authorize: () => Promise<void>,
    ) {}

    async start(): Promise<void> {
        const child = await this.scope.start(this.command, this.args, this.cwd, this.env, this.authorize);
        this.child = child;
        const fail = (error: ProbeError): void => {
            this.failure = error;
            this.onerror?.(error);
            void this.close();
        };
        child.stdout.on('data', (chunk: Buffer) => {
            try {
                this.total += chunk.length;
                if (this.total > 8 * 1024 * 1024) {
                    throw new ProbeError('failed', 'output-limit');
                }
                this.buffer.append(chunk);
                for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage()) {
                    this.onmessage?.(message);
                }
            } catch (error) {
                fail(error instanceof ProbeError ? error : new ProbeError('failed', 'mcp-connect-failed'));
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            this.total += chunk.length;
            if (this.total > 8 * 1024 * 1024) {
                fail(new ProbeError('failed', 'output-limit'));
            }
        });
        child.once('close', () => this.onclose?.());
        child.once('error', () => fail(new ProbeError('failed', 'mcp-connect-failed')));
    }
    async send(message: JSONRPCMessage): Promise<void> {
        if (!this.child?.stdin.writable) {
            throw new ProbeError('failed', 'mcp-connect-failed');
        }
        const bytes = serializeMessage(message);
        await new Promise<void>((resolve, reject) => {
            this.child!.stdin.write(bytes, (error) =>
                error ? reject(new ProbeError('failed', 'mcp-connect-failed')) : resolve(),
            );
        });
    }
    async close(): Promise<void> {
        if (this.child) {
            this.scope.stop(this.child);
            this.child = undefined;
        }
        this.buffer.clear();
        this.onclose?.();
    }
}
