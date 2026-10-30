import { createHash } from 'node:crypto';
import os from 'node:os';
import { api, apiHub, readState, type Credentials } from './state.js';
import { projectBindingId, projectFolder, projectInstanceId } from './workspace.js';
import { readOpenCodeModelMetadata } from './opencode-model-scan.js';
import type { IOpenCodeModelScan, IOpenCodeModelSource } from '../../../../services/shared/opencode-model-scan.cjs';

interface Context { schemaVersion:2; global:{deviceId:string}; revision: number; enabled: boolean; transferCredentials: boolean; bindings: Array<{ projectId: string; bindingId: string; instanceId: string }> }
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
/** UUIDs and timestamps never turn an unchanged configuration into a fresh import. */
export function openCodeSnapshotFingerprint(scan: IOpenCodeModelScan, credentials: Record<string, string>): string {
    const candidates = scan.candidates.map(({ candidateId, ...candidate }) => ({ ...candidate, credentialDigest: credentials[candidateId] ? createHash('sha256').update(credentials[candidateId]!).digest('hex') : null }))
        .sort((a, b) => JSON.stringify([a.provider, a.configKey ?? a.model]).localeCompare(JSON.stringify([b.provider, b.configKey ?? b.model])));
    return createHash('sha256').update(JSON.stringify(canonical({ source:scan.scope==='global'?{scope:scan.scope,deviceId:scan.deviceId}:{scope:scan.scope,projectId:scan.projectId,bindingId:scan.bindingId,instanceId:scan.instanceId}, warnings: [...scan.warnings].sort(), candidates }))).digest('hex');
}
export function secureOpenCodeCredentialTransport(address: string): boolean {
    try { const url = new URL(address); return url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); } catch { return false; }
}

/** One background scan per minute; no inference, SDK execution, configuration writes or secret-bearing durable queue. */
export function createOpenCodeModelSynchronizer(dependencies = { api, hub: apiHub, readState, projectFolder, projectBindingId, projectInstanceId, readOpenCodeModelMetadata }) {
    let pending: Promise<void> | undefined, lastAttempt = -Infinity;
    const acknowledged = new Map<string, { digest: string; at: number }>();
    return (stopped: () => boolean = () => false): Promise<void> => {
        if (pending) return pending;
        if (stopped() || Date.now() - lastAttempt < 60000) return Promise.resolve();
        lastAttempt = Date.now();
        pending = (async () => {
            const identity = await dependencies.readState<Credentials>('credentials');
            if (!identity || stopped()) return;
            const context = await dependencies.api<Context>('opencode-models/context', {}, identity.token);
            if (context?.schemaVersion!==2 || context.global?.deviceId!==identity.deviceId || !context.enabled || !Array.isArray(context.bindings) || context.bindings.length > 1000) return;
            const authorize = async (): Promise<void> => {
                const current = await dependencies.readState<Credentials>('credentials');
                if (stopped() || current?.deviceId !== identity.deviceId || current.token !== identity.token) throw Error('Подключение компьютера изменилось.');
            };
            const sources:IOpenCodeModelSource[]=[{scope:'global',deviceId:identity.deviceId},...context.bindings.map(binding=>({scope:'project' as const,...binding}))];
            for (const source of sources) {
                await authorize();
                try {
                    const assertBinding = async (): Promise<void> => {
                        await authorize();
                        if (source.scope==='project'&&(source.bindingId !== await dependencies.projectBindingId(source.projectId) || source.instanceId !== await dependencies.projectInstanceId(source.projectId))) throw Error('Папка проекта изменилась.');
                    };
                    await assertBinding();
                    const credentials: Record<string, string> = {};
                    const scan = await dependencies.readOpenCodeModelMetadata(source.scope==='project'?await dependencies.projectFolder(source.projectId):os.homedir(), source, {
                        authorize: assertBinding, readAuth:false,
                    });
                    await assertBinding();
                    const key = JSON.stringify([identity.deviceId, source, context.revision]);
                    const digest = openCodeSnapshotFingerprint(scan, credentials), last = acknowledged.get(key);
                    if (last?.digest === digest && Date.now() - last.at < 600000) continue;
                    await dependencies.api('opencode-models/sync', { settingsRevision: context.revision, scan, credentials }, identity.token);
                    acknowledged.set(key, { digest, at: Date.now() });
                    if (acknowledged.size > 1000) acknowledged.delete(acknowledged.keys().next().value!);
                } catch { /* A failed source never blocks jobs or other valid bindings. */ }
            }
        })().finally(() => { pending = undefined; });
        return pending;
    };
}
export const synchronizeOpenCodeModels = createOpenCodeModelSynchronizer();
