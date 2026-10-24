import type { ProjectChatTransport } from './project-chat.types';

interface Waiter { signal: AbortSignal; abort(): void; grant(release: () => void): void }
interface Lane { waiters: Waiter[] }

/** One server and one device call per project in this Catalog instance; cancellation never skips a held permit. */
export class ProjectChatDispatch {
    private readonly lanes = new Map<string, Lane>();
    async run<T>(projectId: string, transport: ProjectChatTransport, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
        const release = await this.acquire(JSON.stringify([projectId, transport]), signal);
        try { signal.throwIfAborted(); return await action(); }
        finally { release(); }
    }
    private acquire(key: string, signal: AbortSignal): Promise<() => void> {
        signal.throwIfAborted();
        const existing = this.lanes.get(key);
        if (existing) return new Promise((grant, reject) => {
            const waiter: Waiter = { signal, grant, abort: () => {
                const index = existing.waiters.indexOf(waiter);
                if (index >= 0) existing.waiters.splice(index, 1);
                reject(signal.reason);
            } };
            existing.waiters.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true });
        });
        const lane: Lane = { waiters: [] }; this.lanes.set(key, lane);
        const release = () => {
            const next = lane.waiters.shift();
            if (next) { next.signal.removeEventListener('abort', next.abort); next.grant(release); }
            else this.lanes.delete(key);
        };
        return Promise.resolve(release);
    }
}
