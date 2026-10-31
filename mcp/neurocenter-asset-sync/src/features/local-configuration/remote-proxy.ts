import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Package } from '../../bridge/package.js';

/** Прокси передаёт сообщения только на закреплённый URL, без OAuth, discovery и перенаправлений. */
export async function startConfiguredRemote(pkg: Package, headers: Record<string, string>): Promise<void> {
    const url = new URL(pkg.config?.url ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new Error('configuration-required');
    }
    const local = new StdioServerTransport();
    const remote = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { ...pkg.config?.headers, ...headers }, redirect: 'error' },
        reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1,
            maxReconnectionDelay: 1,
            reconnectionDelayGrowFactor: 1,
        },
        fetch: async (input, init) => {
            if (new URL(input).href !== url.href) {
                throw new Error('configuration-required');
            }
            return fetch(input, { ...init, redirect: 'error' });
        },
    });
    const stop = () => {
        void local.close();
        void remote.close();
    };
    local.onmessage = (message) => {
        void remote.send(message).catch(stop);
    };
    remote.onmessage = (message) => {
        void local.send(message).catch(stop);
    };
    local.onerror = stop;
    remote.onerror = stop;
    local.onclose = () => {
        void remote.close();
    };
    remote.onclose = () => {
        void local.close();
    };
    await remote.start();
    await local.start();
}
