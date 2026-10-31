import { BadRequestException } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import type { IModel } from '../models/model.types';
import type { IRemoteConnectionRow } from '../models/remote-connection.repository';
import { remoteModelBaseUrl } from '../models/remote-model-validation';
import { canStoreModelCredential, openModelCredential, sealModelCredential } from '../models/remote-model-secret';
import type { RemoteAuthMode, RemoteProviderMutation } from './remote-provider.types';

export const providerFence = (modelId: string) => 'neurocenter:remote-provider:model:' + modelId;
export const credentialFence = (email: string, providerId: string) =>
    JSON.stringify(['neurocenter:remote-provider:user', email, providerId]);
const namespace = (email: string, providerId: string) =>
    JSON.stringify(['personal-remote-provider', 1, email, providerId]);
export const remoteProviderId = (model: Pick<IModel, 'id' | 'runtime'>, row: Pick<IRemoteConnectionRow, 'base_url'>) =>
    createHash('sha256')
        .update(
            JSON.stringify([
                'neurocenter:remote-provider',
                1,
                model.id,
                model.runtime,
                remoteModelBaseUrl(row.base_url),
            ]),
        )
        .digest('hex');
export function remoteAuthMode(
    row: Pick<IRemoteConnectionRow, 'credential_kind'> & { auth_mode?: RemoteAuthMode | null },
): RemoteAuthMode {
    return row.auth_mode ?? (row.credential_kind === 'none' ? 'none' : 'required');
}
export const sealUserCredential = (
    secret: string,
    email: string,
    providerId: string,
    revision: number,
    environment: NodeJS.ProcessEnv = process.env,
) => sealModelCredential(secret, namespace(email, providerId), revision, environment);
export const openUserCredential = (
    value: Parameters<typeof openModelCredential>[0],
    email: string,
    providerId: string,
    revision: number,
    environment: NodeJS.ProcessEnv = process.env,
) => openModelCredential(value, namespace(email, providerId), revision, environment);

/** The fingerprint is private HMAC for a save, never a reusable unsalted hash of the user's key. */
export function remoteMutationHash(
    modelId: string,
    email: string,
    action: 'save' | 'delete',
    input: RemoteProviderMutation,
    environment: NodeJS.ProcessEnv = process.env,
): string {
    const bytes = JSON.stringify([modelId, email, action, input]);
    if (action === 'delete') return createHash('sha256').update(bytes).digest('hex');
    if (!canStoreModelCredential(environment))
        throw new BadRequestException('Хранилище личных ключей не настроено. Обратитесь к администратору.');
    return createHmac('sha256', Buffer.from(environment.NEUROCENTER_MODEL_CREDENTIAL_KEY!, 'base64'))
        .update('neurocenter:personal-key-request:v1\0')
        .update(bytes)
        .digest('hex');
}
export function remoteProviderMutation(raw: unknown, action: 'save' | 'delete'): RemoteProviderMutation {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new BadRequestException('Передайте ревизии личного доступа и ключ повтора.');
    const value = raw as Record<string, unknown>,
        keys = [
            'providerId',
            'expectedConnectionRevision',
            'expectedCredentialRevision',
            'requestKey',
            ...(action === 'save' ? ['apiKey'] : []),
        ];
    if (
        Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
        typeof value.providerId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.providerId) ||
        typeof value.requestKey !== 'string' ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.requestKey) ||
        !Number.isSafeInteger(value.expectedConnectionRevision) ||
        Number(value.expectedConnectionRevision) < 1 ||
        !Number.isSafeInteger(value.expectedCredentialRevision) ||
        Number(value.expectedCredentialRevision) < 0 ||
        (action === 'save' &&
            (typeof value.apiKey !== 'string' ||
                !value.apiKey ||
                value.apiKey.length > 8192 ||
                /[\x00-\x20\x7f]/.test(value.apiKey)))
    )
        throw new BadRequestException('Проверьте подключение, ревизию и непустой API-ключ без пробелов.');
    return {
        providerId: value.providerId,
        expectedConnectionRevision: Number(value.expectedConnectionRevision),
        expectedCredentialRevision: Number(value.expectedCredentialRevision),
        requestKey: value.requestKey,
        ...(action === 'save' ? { apiKey: String(value.apiKey) } : {}),
    };
}
