import type { TProjectChatTransport } from './project-chat.interfaces';

interface IWaiter {
    signal: AbortSignal;
    abort(): void;
    grant(release: () => void): void;
}
interface ILane {
    waiters: IWaiter[];
}

/** One server and one device call per project in this Catalog instance; cancellation never skips a held permit. */
export class ProjectChatDispatch {
    private readonly lanes = new Map<string, ILane>();
    async run<T>(
        projectId: string,
        transport: TProjectChatTransport,
        signal: AbortSignal,
        action: () => Promise<T>,
    ): Promise<T> {
        const release = await this.acquire(JSON.stringify([projectId, transport]), signal);
        try {
            signal.throwIfAborted();
            return await action();
        } finally {
            release();
        }
    }
    private acquire(key: string, signal: AbortSignal): Promise<() => void> {
        signal.throwIfAborted();
        const existing = this.lanes.get(key);
        if (existing)
            return new Promise((grant, reject) => {
                const waiter: IWaiter = {
                    signal,
                    grant,
                    abort: () => {
                        const index = existing.waiters.indexOf(waiter);
                        if (index >= 0) existing.waiters.splice(index, 1);
                        reject(signal.reason);
                    },
                };
                existing.waiters.push(waiter);
                signal.addEventListener('abort', waiter.abort, { once: true });
            });
        const lane: ILane = { waiters: [] };
        this.lanes.set(key, lane);
        const release = () => {
            const next = lane.waiters.shift();
            if (next) {
                next.signal.removeEventListener('abort', next.abort);
                next.grant(release);
            } else this.lanes.delete(key);
        };
        return Promise.resolve(release);
    }
}
