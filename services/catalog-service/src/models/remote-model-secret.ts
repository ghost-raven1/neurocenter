import { ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface ISealedModelCredential {
    schemaVersion: 1;
    algorithm: 'A256GCM';
    keyId: string;
    nonce: string;
    tag: string;
    data: string;
}
const secretError = () => new ServiceUnavailableException('Не удалось открыть ключ модели. Проверьте NEUROCENTER_MODEL_CREDENTIAL_KEY; сохранённый ключ не изменён.');

function masterKey(environment: NodeJS.ProcessEnv): Buffer {
    const raw = environment.NEUROCENTER_MODEL_CREDENTIAL_KEY;
    if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) { throw secretError(); }
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== raw) { throw secretError(); }
    return bytes;
}
const keyId = (key: Buffer) => createHash('sha256').update('neurocenter:model-credential:v1\0').update(key).digest('hex').slice(0, 24);
const aad = (modelId: string, revision: number) => Buffer.from(JSON.stringify(['neurocenter:model-credential', 1, modelId, revision]));

/** Уникальный nonce и AAD не позволяют перенести зашифрованный ключ между моделями и ревизиями. */
export function sealModelCredential(value: string, modelId: string, revision: number, environment: NodeJS.ProcessEnv = process.env): ISealedModelCredential {
    if (!value || value.length > 8192 || /[\x00-\x20\x7f]/.test(value) || !Number.isSafeInteger(revision) || revision < 1) { throw secretError(); }
    const key = masterKey(environment), nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(modelId, revision));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { schemaVersion: 1, algorithm: 'A256GCM', keyId: keyId(key), nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}

/** Расшифровка применяется только внутри server-side inference; секрет никогда не возвращается DTO. */
export function openModelCredential(value: ISealedModelCredential, modelId: string, revision: number, environment: NodeJS.ProcessEnv = process.env): string {
    try {
        const key = masterKey(environment);
        if (!value || value.schemaVersion !== 1 || value.algorithm !== 'A256GCM' || value.keyId !== keyId(key)
            || typeof value.data !== 'string' || value.data.length > 11000 || typeof value.nonce !== 'string' || typeof value.tag !== 'string') { throw secretError(); }
        const nonce = Buffer.from(value.nonce, 'base64'), tag = Buffer.from(value.tag, 'base64'), data = Buffer.from(value.data, 'base64');
        if (nonce.length !== 12 || tag.length !== 16 || nonce.toString('base64') !== value.nonce || tag.toString('base64') !== value.tag || data.toString('base64') !== value.data) { throw secretError(); }
        const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(aad(modelId, revision)); decipher.setAuthTag(tag);
        const secret = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
        if (!secret || /[\x00-\x20\x7f]/.test(secret)) { throw secretError(); }
        return secret;
    } catch { throw secretError(); }
}

export function canStoreModelCredential(environment: NodeJS.ProcessEnv = process.env): boolean {
    try { masterKey(environment); return true; } catch { return false; }
}
