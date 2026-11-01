import path from 'node:path';
import type { IOptions, IIntent } from './interfaces.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { contract } from '../contract.js';
import type {
    IOpenCodeAccountInventory,
    IOpenCodeAccountMetadata,
} from '../../../../../../services/shared/opencode-local-providers.cjs';
import { GlobalProviderInputError } from '../editor.js';
import { snapshot, publish, conflict, type ILocalSnapshot } from '../files.js';
import { AccountsClient, AccountsUnavailable } from './client.js';
const mutations = new Set<string>();
/** Adds Anthropic accounts without switching existing accounts or editing configuration; OpenCode activates its first account. */
export class AccountsEditor {
    private readonly file: string;
    private preview?: IIntent;
    constructor(private readonly options: IOptions) {
        this.file = path.join(
            options.environment.XDG_STATE_HOME || path.join(options.home, '.local/state'),
            'neurocenter',
            'opencode-v2-accounts',
            'intent.json',
        );
    }
    private async admit() {
        this.options.signal?.throwIfAborted();
        this.options.current?.();
        await this.options.authorize();
        this.options.current?.();
        this.options.signal?.throwIfAborted();
    }
    private async client() {
        await this.admit();
        const proof = await this.options.assertCompatibleCli();
        await proof.assertCurrent();
        const client = await AccountsClient.discover(
            this.options.home,
            this.options.environment,
            this.options.limits.fileBytes,
            this.options.signal,
        );
        await proof.assertCurrent();
        await this.admit();
        return {
            client,
            verify: async () => {
                await this.admit();
                await proof.assertCurrent();
                await client.current();
                await this.admit();
            },
        };
    }
    async inventory(): Promise<IOpenCodeAccountInventory> {
        try {
            const { client } = await this.client(),
                rows = await client.list(),
                accounts = new Map<string, IOpenCodeAccountMetadata>();
            for (const row of rows) {
                const item = accounts.get(row.integrationID) ?? {
                    integrationId: row.integrationID,
                    hasApiKey: false,
                    hasOAuth: false,
                    hasExternal: false,
                };
                item.hasApiKey ||= row.value.type === 'key';
                item.hasOAuth ||= row.value.type === 'oauth';
                item.hasExternal ||= row.value.type === 'external';
                accounts.set(row.integrationID, item);
            }
            await this.admit();
            return contract.normalizeOpenCodeAccountInventory({
                accounts: [...accounts.values()].slice(0, this.options.limits.providers),
                issues: accounts.size > this.options.limits.providers ? ['entry-limit'] : [],
            });
        } catch (error) {
            await this.admit();
            return {
                accounts: [],
                issues: [
                    error instanceof AccountsUnavailable
                        ? error.issue
                        : (error as { code?: string })?.code === 'OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED'
                          ? 'unsupported-version'
                          : 'read-failed',
                ],
            };
        }
    }
    private async read() {
        const before = await snapshot(this.file, this.options.limits.fileBytes, true);
        let intent: IIntent | undefined;
        if (before.text !== null) {
            try {
                intent = JSON.parse(before.text) as IIntent;
            } catch {
                throw conflict();
            }
            if (
                !intent ||
                !/^neurocenter-[0-9a-f-]{36}$/.test(intent.id) ||
                typeof intent.key !== 'string' ||
                !intent.key ||
                Buffer.byteLength(intent.key) > this.options.limits.secretBytes ||
                typeof intent.complete !== 'boolean' ||
                !intent.server ||
                typeof intent.server.id !== 'string'
            )
                throw conflict();
        }
        return { before, intent };
    }
    private async write(intent: IIntent, before: ILocalSnapshot, verify: () => Promise<void>) {
        const text = JSON.stringify(intent);
        if (Buffer.byteLength(text) > this.options.limits.fileBytes) throw conflict();
        await publish(before, text, this.options.limits.fileBytes, () => this.admit(), verify);
    }
    async lastSave() {
        await this.admit();
        const { intent } = await this.read();
        return intent
            ? { intentId: intent.id, providerId: 'anthropic', status: intent.complete ? 'saved' : 'partial' }
            : undefined;
    }
    async prepare(value: Record<string, unknown>) {
        await this.admit();
        this.preview = undefined;
        if (
            Object.keys(value).some((key) => !['providerId', 'apiKey'].includes(key)) ||
            value.providerId !== 'anthropic' ||
            typeof value.apiKey !== 'string' ||
            !value.apiKey.trim() ||
            Buffer.byteLength(value.apiKey) > this.options.limits.secretBytes ||
            /[\r\n\0]/.test(value.apiKey)
        )
            throw new GlobalProviderInputError(
                'Выберите Anthropic и введите новый API-ключ. Другие типы учётных записей доступны только для чтения.',
            );
        const previous = await this.read();
        if (previous.intent && !previous.intent.complete) throw conflict();
        const { client, verify } = await this.client();
        await client.list();
        await verify();
        this.preview = {
            id: 'neurocenter-' + randomUUID(),
            key: value.apiKey,
            server: client.identity(),
            complete: false,
        };
        return { previewId: this.preview.id, providerId: 'anthropic' };
    }
    private async exclusive<T>(action: () => Promise<T>) {
        if (mutations.has(this.file)) throw conflict();
        mutations.add(this.file);
        try {
            return await action();
        } finally {
            mutations.delete(this.file);
        }
    }
    async save(value: Record<string, unknown>) {
        return this.exclusive(() => this.savePrepared(value));
    }
    private async savePrepared(value: Record<string, unknown>) {
        const intent = this.preview;
        if (!intent || value.previewId !== intent.id) throw conflict();
        const { client, verify } = await this.client();
        if (!isDeepStrictEqual(client.identity(), intent.server)) throw conflict();
        const previous = await this.read();
        if (previous.intent && !previous.intent.complete) throw conflict();
        await this.write(intent, previous.before, verify);
        this.preview = undefined;
        return this.reconcile({ intentId: intent.id });
    }
    /** Reconcile the same durable ID before every retry: a lost ACK never creates a second account. */
    async resume(value: Record<string, unknown>) {
        return this.exclusive(() => this.reconcile(value));
    }
    private async reconcile(value: Record<string, unknown>) {
        const record = await this.read(),
            intent = record.intent;
        if (!intent || intent.id !== value.intentId) throw conflict();
        const { client, verify } = await this.client();
        if (!isDeepStrictEqual(client.identity(), intent.server)) throw conflict();
        let existing = (await client.list()).find((item) => item.id === intent.id);
        if (!existing && !intent.complete) {
            await verify();
            try {
                await client.add(intent.id, intent.key);
            } catch {
                /* An unknown ACK must be reconciled, never retried with another ID. */
            }
            await verify();
            existing = (await client.list()).find((item) => item.id === intent.id);
        }
        if (!existing)
            throw new GlobalProviderInputError(
                'Ответ OpenCode не подтверждён. Перечитайте состояние и продолжите сохранённое добавление. Новый аккаунт повторно не создаётся.',
            );
        if (
            existing.integrationID !== 'anthropic' ||
            existing.value.type !== 'key' ||
            existing.value.key !== intent.key
        )
            throw conflict();
        await verify();
        await this.write({ ...intent, complete: true }, record.before, verify);
        return {
            note: 'Новая учётная запись Anthropic сохранена. Старые аккаунты сохранены; первый аккаунт OpenCode активирует автоматически. Запрос модели не выполнялся.',
        };
    }
}
