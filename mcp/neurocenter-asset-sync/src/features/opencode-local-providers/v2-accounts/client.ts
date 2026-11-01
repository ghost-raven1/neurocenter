import path from 'node:path';
import { roleMcpProcessOwner } from '../../system-role-mcp/owned-process.js';
import { accountRequest } from './transport.js';
import { snapshot, unchanged, type ILocalSnapshot } from '../files.js';
import { contract } from '../contract.js';

import type { IAccount, IRegistration } from './interfaces.js';
/** Only fixed errors may cross the private HTTP boundary. */
export class AccountsUnavailable extends Error {
    constructor(
        readonly issue:
            'session-unavailable' | 'unsupported-version' | 'read-failed' | 'source-changed' = 'session-unavailable',
    ) {
        super('OpenCode 2: запустите обычный OpenCode 2.2.2 на этом компьютере и перечитайте состояние.');
    }
}
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

/** Reads only an existing private service registration; never starts or stops the borrowed server. */
export class AccountsClient {
    private constructor(
        private readonly registration: IRegistration,
        private readonly before: ILocalSnapshot,
        private readonly maximum: number,
        private readonly signal?: AbortSignal,
        private readonly processBirth?: string,
    ) {}
    static async discover(home: string, environment: NodeJS.ProcessEnv, maximum: number, signal?: AbortSignal) {
        const file = path.join(
            environment.XDG_STATE_HOME || path.join(home, '.local/state'),
            'opencode',
            'service.json',
        );
        const before = await snapshot(file, Math.min(maximum, 16384), true);
        if (!before.text) throw new AccountsUnavailable();
        let value: unknown;
        try {
            value = JSON.parse(before.text);
        } catch {
            throw new AccountsUnavailable();
        }
        if (
            !object(value) ||
            typeof value.id !== 'string' ||
            !value.id ||
            value.id.length > 256 ||
            typeof value.url !== 'string' ||
            typeof value.password !== 'string' ||
            !value.password ||
            value.password.length > 4096 ||
            !Number.isSafeInteger(value.pid) ||
            Number(value.pid) <= 0
        )
            throw new AccountsUnavailable();
        if (value.version !== contract.OPENCODE_V2_ACCOUNTS_VERSION)
            throw new AccountsUnavailable('unsupported-version');
        let url: URL;
        try {
            url = new URL(value.url);
        } catch {
            throw new AccountsUnavailable();
        }
        if (
            url.protocol !== 'http:' ||
            url.hostname !== '127.0.0.1' ||
            !url.port ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search ||
            url.hash
        )
            throw new AccountsUnavailable();
        const owner = await roleMcpProcessOwner(Number(value.pid), '');
        const client = new AccountsClient(value as unknown as IRegistration, before, maximum, signal, owner.birth);
        await client.current();
        return client;
    }
    /** Identity is private, and never a public completion field or credential digest. */
    identity() {
        return { ...this.registration };
    }
    async current() {
        const owner = await roleMcpProcessOwner(this.registration.pid, '');
        if (owner.birth !== this.processBirth) throw new AccountsUnavailable('source-changed');
        await unchanged(this.before, Math.min(this.maximum, 16384));
        const info = await this.request('/api/info');
        if (!object(info) || info.version !== this.registration.version || info.pid !== this.registration.pid)
            throw new AccountsUnavailable('source-changed');
        await unchanged(this.before, Math.min(this.maximum, 16384));
    }
    private async request(route: string, body?: unknown): Promise<unknown> {
        try {
            return await accountRequest(
                new URL(route, this.registration.url),
                this.registration.password,
                this.maximum,
                this.signal,
                body,
            );
        } catch {
            throw new AccountsUnavailable('read-failed');
        }
    }

    async list(): Promise<IAccount[]> {
        await this.current();
        const raw = await this.request('/api/credential');
        if (!object(raw) || !Array.isArray(raw.data) || raw.data.length > 1000)
            throw new AccountsUnavailable('read-failed');
        const accounts: IAccount[] = [];
        for (const item of raw.data) {
            if (
                !object(item) ||
                typeof item.id !== 'string' ||
                !item.id ||
                item.id.length > 256 ||
                !contract.globalProviderId(item.integrationID) ||
                !object(item.value) ||
                !['key', 'oauth', 'external'].includes(String(item.value.type))
            )
                throw new AccountsUnavailable('read-failed');
            accounts.push({
                id: item.id,
                integrationID: item.integrationID,
                value: {
                    type: String(item.value.type),
                    ...(item.value.type === 'key' && typeof item.value.key === 'string' ? { key: item.value.key } : {}),
                },
            });
        }
        await this.current();
        return accounts;
    }
    async add(id: string, key: string) {
        await this.current();
        // First account activation is upstream semantics even when activate is false.
        await this.request('/api/credential', {
            id,
            integrationID: 'anthropic',
            value: { type: 'key', key },
            activate: false,
        });
        await this.current();
    }
}
