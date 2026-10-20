import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { IModel } from './model.types';
import type { IRemoteConnectionInput, IRemoteModelConnection } from './remote-model.types';

/** Адрес разрешает явный self-hosted API, но не credentials, redirects и metadata endpoints. */
export function remoteModelBaseUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length > 1024 || /[\s\\\x00-\x1f\x7f%]/.test(value) || /\/\.\.(?:\/|$)/.test(value)) { throw new BadRequestException('Укажите адрес API без пароля, параметров и управляющих знаков.'); }
    let url: URL;
    try { url = new URL(value); } catch { throw new BadRequestException('Некорректный адрес удалённого API.'); }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
        || !/^[a-zA-Z0-9/_.-]*$/.test(url.pathname) || ['metadata.google.internal', 'metadata', 'instance-data'].includes(host)
        || host === '0.0.0.0' || host === '::' || /^169\.254\./.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
        || /^::ffff:/.test(host) || host === 'fd00:ec2::254' || isIP(host) === 4 && Number(host.split('.')[0]) >= 224) {
        throw new BadRequestException('Выберите HTTP(S) API модели; адреса metadata и служебные сетевые адреса недопустимы.');
    }
    return url.origin + url.pathname.replace(/\/+$/, '');
}

/** Секрет можно заменить или сохранить; он не входит в описание модели и экспорт ассета. */
export function remoteConnectionInput(value: unknown): IRemoteConnectionInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new BadRequestException('Передайте настройки удалённого подключения.'); }
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some(key => !['expectedRevision', 'expectedModelRevision', 'baseUrl', 'requestDimensions', 'credential', 'apiKey', 'credentialEnv'].includes(key))
        || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0
        || !Number.isSafeInteger(body.expectedModelRevision) || Number(body.expectedModelRevision) < 1
        || typeof body.requestDimensions !== 'boolean' || !['none', 'stored', 'environment'].includes(String(body.credential))) {
        throw new BadRequestException('Проверьте ревизию, способ авторизации и размерность подключения.');
    }
    if (body.apiKey !== undefined && (body.credential !== 'stored' || typeof body.apiKey !== 'string' || !body.apiKey.trim()
        || body.apiKey.length > 8192 || /[\x00-\x20\x7f]/.test(body.apiKey))) { throw new BadRequestException('Введите непустой API-ключ без пробелов и управляющих знаков.'); }
    if (body.credential === 'environment' ? typeof body.credentialEnv !== 'string' || !/^NEUROCENTER_REMOTE_MODEL_[A-Z0-9_]{1,100}$/.test(body.credentialEnv)
        : body.credentialEnv !== undefined) { throw new BadRequestException('Для ключа окружения используйте имя NEUROCENTER_REMOTE_MODEL_*.'); }
    return { expectedRevision: Number(body.expectedRevision), expectedModelRevision: Number(body.expectedModelRevision), baseUrl: remoteModelBaseUrl(body.baseUrl), requestDimensions: body.requestDimensions,
        credential: body.credential as IRemoteConnectionInput['credential'], ...(body.apiKey === undefined ? {} : { apiKey: String(body.apiKey) }),
        ...(body.credentialEnv === undefined ? {} : { credentialEnv: String(body.credentialEnv) }) };
}

/** Pin отражает семантику API; ротация ключа отдельно проверяется ревизией приватного подключения. */
export function remoteVerificationDigest(model: IModel, connection: IRemoteModelConnection, dimension: number | null): string {
    return createHash('sha256').update(JSON.stringify({ schemaVersion: 1, runtime: model.runtime, model: model.model, modelVersion: model.modelVersion,
        capability: model.capability, baseUrl: remoteModelBaseUrl(connection.baseUrl), requestDimensions: connection.requestDimensions, dimension })).digest('hex');
}
