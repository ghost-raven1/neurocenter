import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Package } from '../../bridge/package.js';
import { ProbeError } from './model.js';
import { packageEnvironment, type ProbeProfile } from './profile.js';
import type { ProbeScope } from './process.js';
import { ProbeStdioTransport } from './mcp-transport.js';
import { resolvePreparedRuntimeArtifact } from '../runtime-artifacts/cache.js';

interface Counts {
    tools: number;
    resources: number;
    prompts: number;
}
async function remoteTransport(pkg: Package, scope: ProbeScope, authorize: () => Promise<void>): Promise<Transport> {
    let url: URL;
    try {
        url = new URL(pkg.config?.url ?? '');
    } catch {
        throw new ProbeError('needs_configuration', 'configuration-required');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new ProbeError('unsupported', 'configuration-required');
    }
    if (Object.values(pkg.config?.headers ?? {}).some((value) => /\{env:|\$\{/.test(value))) {
        throw new ProbeError('needs_configuration', 'configuration-required');
    }
    let headers: Headers;
    try {
        headers = new Headers(pkg.config?.headers ?? {});
    } catch {
        throw new ProbeError('needs_configuration', 'configuration-required');
    }
    await scope.authorize(authorize);
    let received = 0;
    const transport: Transport & { failure?: ProbeError } = new StreamableHTTPClientTransport(url, {
        // Отсутствие authProvider запрещает OAuth discovery, регистрацию и открытие браузера.
        requestInit: { headers, redirect: 'error' },
        reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1,
            maxReconnectionDelay: 1,
            reconnectionDelayGrowFactor: 1,
        },
        fetch: async (input, init) => {
            if (new URL(input).href !== url.href) {
                throw new ProbeError('unsupported', 'configuration-required');
            }
            const response = await fetch(input, {
                ...init,
                redirect: 'error',
                signal: init?.signal
                    ? AbortSignal.any([scope.controller.signal, init.signal])
                    : scope.controller.signal,
            });
            if ([401, 403].includes(response.status)) {
                await response.body?.cancel();
                transport.failure = new ProbeError('needs_configuration', 'configuration-required');
                throw transport.failure;
            }
            const body = response.body?.pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({
                    transform(chunk, controller) {
                        received += chunk.byteLength;
                        if (received > 8 * 1024 * 1024) {
                            transport.failure = new ProbeError('failed', 'output-limit');
                            throw transport.failure;
                        }
                        controller.enqueue(chunk);
                    },
                }),
            );
            return new Response(body ?? null, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        },
    });
    return transport;
}

/** Выполняет только initialize и списки объявленных возможностей; tools/call и чтения ресурсов отсутствуют. */
export async function probeMcp(
    pkg: Package,
    profile: ProbeProfile,
    scope: ProbeScope,
    authorize: () => Promise<void>,
): Promise<Counts> {
    let transport: Transport;
    if (pkg.config?.transport === 'remote') {
        transport = await remoteTransport(pkg, scope, authorize);
    } else {
        const artifact = await resolvePreparedRuntimeArtifact(pkg);
        const entrypoint = pkg.config?.entrypoint;
        if (!artifact && (!pkg.files.length || !['node', process.execPath].includes(pkg.config?.command ?? ''))) {
            throw new ProbeError('unsupported', 'external-command-unsupported');
        }
        if (
            !artifact &&
            (!entrypoint || !pkg.files.some((file) => file.path === entrypoint) || !/\.(?:[cm]?js)$/i.test(entrypoint))
        ) {
            throw new ProbeError('unsupported', 'entrypoint-unsupported');
        }
        transport = new ProbeStdioTransport(
            scope,
            artifact?.executable ? artifact.entrypoint : process.execPath,
            [
                ...(artifact?.executable
                    ? []
                    : [artifact?.entrypoint ?? path.join(profile.packageDirectory(pkg), entrypoint!)]),
                ...(pkg.config?.args ?? []),
            ],
            profile.project,
            packageEnvironment(pkg, profile.env),
            authorize,
        );
    }
    const client = new Client({ name: 'neurocenter-runtime-probe', version: '1' }, { capabilities: {} });
    let phase = 'connect';
    try {
        await scope.wait(client.connect(transport, { timeout: scope.remaining() }));
        phase = 'list';
        const capabilities = client.getServerCapabilities();
        const counts: Counts = { tools: 0, resources: 0, prompts: 0 };
        for (const category of ['tools', 'resources', 'prompts'] as const) {
            if (!capabilities?.[category]) {
                continue;
            }
            let cursor: string | undefined;
            const seen = new Set<string>();
            for (let page = 0; ; page++) {
                if (page >= 10) {
                    throw new ProbeError('failed', 'output-limit');
                }
                await scope.authorize(authorize);
                const options = { timeout: scope.remaining(), signal: scope.controller.signal };
                const params = cursor ? { cursor } : undefined;
                const response =
                    category === 'tools'
                        ? await scope.wait(client.listTools(params, options))
                        : category === 'resources'
                          ? await scope.wait(client.listResources(params, options))
                          : await scope.wait(client.listPrompts(params, options));
                const entries =
                    category === 'tools'
                        ? (response as { tools: unknown[] }).tools
                        : category === 'resources'
                          ? (response as { resources: unknown[] }).resources
                          : (response as { prompts: unknown[] }).prompts;
                counts[category] += entries.length;
                if (counts[category] > 1000) {
                    throw new ProbeError('failed', 'output-limit');
                }
                cursor = response.nextCursor;
                if (!cursor) {
                    break;
                }
                if (seen.has(cursor)) {
                    throw new ProbeError('failed', 'output-limit');
                }
                seen.add(cursor);
            }
        }
        return counts;
    } catch (error) {
        const failure = (transport as Transport & { failure?: ProbeError }).failure;
        if (failure) {
            throw failure;
        }
        if (error instanceof ProbeError) {
            throw error;
        }
        scope.remaining();
        throw new ProbeError('failed', phase === 'connect' ? 'mcp-connect-failed' : 'mcp-list-failed');
    } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
    }
}
