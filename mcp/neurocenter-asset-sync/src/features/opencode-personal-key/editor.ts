import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { configurationObject, object } from '../project-configuration/json.js';
import {
    snapshot,
    unchanged,
    assertPath,
    conflict,
    publish,
    type ILocalSnapshot,
} from '../opencode-local-providers/files.js';
import { contract, type IOpenCodePersonalKeyReceipt } from './contract.js';
import type { IPersonalKeyOptions, IPersonalKeyIntent } from './interfaces.js';
const CONFIG_FILE_NAMES = ['config.json', 'opencode.json', 'opencode.jsonc'],
    FILE_BYTES = 1024 * 1024;
/** OpenCode built-in provider endpoints; a local provider without a custom baseURL uses its built-in address. */
const BUILTIN_PROVIDER_URLS: Readonly<Record<string, string>> = { openai: 'https://api.openai.com/v1' };
const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
    const result = { ...a };
    for (const [key, value] of Object.entries(b)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw conflict();
        result[key] =
            object(value) && object(result[key]) ? merge(result[key] as Record<string, unknown>, value) : value;
    }
    return result;
};
interface ILocalSource {
    configFiles: ILocalSnapshot[];
    auth: ILocalSnapshot;
    providerName: string;
}

/** Transfers one explicitly selected stored API key; metadata sync and local auth remain unchanged. */
export class PersonalKeyEditor {
    private preview?: { id: string; source: ILocalSource };
    private busy = false;
    constructor(private readonly options: IPersonalKeyOptions) {}
    async inventory() {
        return {
            recipient: this.options.context.recipient,
            siteOrigin: this.options.siteOrigin,
            apiOrigin: this.options.apiOrigin,
            source: 'OpenCode 1.14.48 (API key)',
        };
    }
    private async admit() {
        this.options.current();
        await this.options.authorize();
        this.options.current();
    }
    private async context() {
        await this.admit();
        const value = contract.normalizeOpenCodePersonalKeyContext(
            await this.options.wire('context', { jobId: this.options.jobId }),
        );
        if (
            !isDeepStrictEqual(value, this.options.context) ||
            value.recipient.ownerEmail !== this.options.ownerEmail ||
            !value.recipient.canStoreKey
        )
            throw conflict();
        await this.admit();
        return value;
    }
    async lastSave(): Promise<IOpenCodePersonalKeyReceipt | null> {
        await this.admit();
        const raw = (await this.options.wire('receipt', { jobId: this.options.jobId })) as { receipt?: unknown };
        if (!raw || typeof raw !== 'object' || Object.keys(raw).length !== 1 || !('receipt' in raw)) throw conflict();
        if (raw.receipt === null) return null;
        const receipt = contract.normalizeOpenCodePersonalKeyReceipt(raw.receipt),
            p = this.options.payload;
        if (
            receipt.jobId !== this.options.jobId ||
            receipt.requestKey !== p.requestKey ||
            receipt.modelId !== p.modelId ||
            receipt.providerId !== p.providerId ||
            receipt.connectionRevision !== p.expectedConnectionRevision ||
            receipt.credentialRevision !== p.expectedCredentialRevision + 1
        )
            throw conflict();
        await this.admit();
        return receipt;
    }
    private async source() {
        // Alternate config/auth owners cannot silently substitute the selected global source.
        if (
            ['OPENCODE_AUTH_CONTENT', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR'].some(
                (key) => !!this.options.environment[key],
            )
        )
            throw conflict();
        const environment = this.options.environment,
            configRoot = path.join(
                environment.XDG_CONFIG_HOME || path.join(this.options.home, '.config'),
                'opencode',
            ),
            configFiles = await Promise.all(
                CONFIG_FILE_NAMES.map((name) => snapshot(path.join(configRoot, name), FILE_BYTES, false)),
            ),
            auth = await snapshot(
                path.join(environment.XDG_DATA_HOME || path.join(this.options.home, '.local/share'), 'opencode', 'auth.json'),
                FILE_BYTES,
                true,
            ),
            providerName = this.resolveProviderName(configFiles);
        this.key(auth, providerName);
        return { configFiles, auth, providerName };
    }
    /** The recipient's canonical address selects exactly one local provider; ambiguity is a hard stop. */
    private resolveProviderName(configFiles: ILocalSnapshot[]): string {
        let config: Record<string, unknown> = {};
        for (const item of configFiles) {
            if (item.text === null) continue;
            try {
                config = merge(config, configurationObject(item.text));
            } catch {
                throw conflict();
            }
        }
        const entries = object(config.provider) ? config.provider : {},
            target = this.options.context.recipient.providerUrl,
            names = [...new Set([...Object.keys(entries), ...Object.keys(BUILTIN_PROVIDER_URLS)])],
            candidates: string[] = [];
        for (const name of names) {
            const entry = object(entries[name]) ? (entries[name] as Record<string, unknown>) : {},
                options = object(entry.options) ? (entry.options as Record<string, unknown>) : {};
            let raw: unknown = options.baseURL;
            if (typeof raw !== 'string' || !raw) raw = BUILTIN_PROVIDER_URLS[name];
            if (typeof raw !== 'string') continue;
            let url: string;
            try {
                url = contract.normalizeOpenCodePersonalKeyProviderUrl(raw);
            } catch {
                continue;
            }
            if (url === target) candidates.push(name);
        }
        if (candidates.length !== 1) throw conflict();
        const name = candidates[0];
        if (!name) throw conflict();
        return name;
    }
    /** The provider resolution depends on the config bytes; an external edit between consent and save aborts. */
    private async assertUnchanged(source: ILocalSource) {
        for (const item of [...source.configFiles, source.auth]) await unchanged(item, FILE_BYTES);
    }
    private key(source: ILocalSnapshot, providerName: string): string {
        let value: unknown;
        try {
            value = JSON.parse(source.text ?? 'null');
        } catch {
            throw conflict();
        }
        const entry =
            value && typeof value === 'object' && !Array.isArray(value)
                ? (value as Record<string, unknown>)[providerName]
                : null;
        if (
            !entry ||
            typeof entry !== 'object' ||
            Array.isArray(entry) ||
            (entry as Record<string, unknown>).type !== 'api'
        )
            throw conflict();
        const key = (entry as Record<string, unknown>).key;
        if (typeof key !== 'string' || !key.trim() || Buffer.byteLength(key) > 8192 || /[\r\n\0]/.test(key))
            throw conflict();
        return key;
    }
    async prepare(value: Record<string, unknown>) {
        if (Object.keys(value).length || this.busy) throw conflict();
        this.preview = undefined;
        await this.context();
        const cli = await this.options.assertCompatibleCli();
        await cli.assertCurrent();
        const source = await this.source();
        await cli.assertCurrent();
        await this.context();
        this.preview = { id: randomUUID(), source };
        return { previewId: this.preview.id, ...(await this.inventory()) };
    }
    private async persist(source: ILocalSnapshot) {
        if (!source.fingerprint) throw conflict();
        const directory = this.options.journalDirectory,
            file = path.join(directory, this.options.jobId + '.json');
        await assertPath(file, true);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(directory);
        if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
        )
            throw conflict();
        const value: IPersonalKeyIntent = {
            schemaVersion: 1,
            jobId: this.options.jobId,
            payload: this.options.payload,
            sourceFingerprint: source.fingerprint,
            siteOrigin: this.options.siteOrigin,
            apiOrigin: this.options.apiOrigin,
            ownerEmail: this.options.ownerEmail,
        };
        const previous = await snapshot(file, 64000, true);
        if (previous.text !== null) {
            if (!isDeepStrictEqual(JSON.parse(previous.text), value)) throw conflict();
        } else {
            await publish(
                previous,
                JSON.stringify(value),
                64000,
                () => this.admit(),
                async () => this.options.current(),
            );
        }
    }
    async save(value: Record<string, unknown>) {
        if (this.busy || Object.keys(value).length !== 1 || !this.preview || value.previewId !== this.preview.id)
            throw conflict();
        this.busy = true;
        try {
            const prior = await this.lastSave();
            if (prior) return { status: 'saved', receipt: prior };
            await this.context();
            const cli = await this.options.assertCompatibleCli();
            await cli.assertCurrent();
            await this.assertUnchanged(this.preview.source);
            await this.persist(this.preview.source.auth);
            await this.context();
            await cli.assertCurrent();
            await this.assertUnchanged(this.preview.source);
            await this.admit();
            // No generic API/outbox transport: key exists only in this bounded private request.
            await this.options.wire('save', {
                jobId: this.options.jobId,
                apiKey: this.key(this.preview.source.auth, this.preview.source.providerName),
            });
            const receipt = await this.lastSave();
            if (!receipt) throw conflict();
            return { status: 'saved', receipt };
        } finally {
            this.busy = false;
        }
    }
    async resume(value: Record<string, unknown>) {
        if (Object.keys(value).length !== 1 || value.intentId !== this.options.jobId) throw conflict();
        const receipt = await this.lastSave();
        return { status: receipt ? 'saved' : 'unknown', receipt };
    }
}
