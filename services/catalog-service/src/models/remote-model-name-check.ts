import { BadRequestException } from '@nestjs/common';
import type { Pool } from 'pg';
import type { TRemoteAuthMode } from '../remote-providers/remote-provider.interfaces';
import { openUserCredential, remoteProviderId } from '../remote-providers/remote-provider.identity';
import { readUserCredential } from '../remote-providers/remote-provider.repository';
import type { IModel } from './model.interfaces';
import type { RemoteModelClient } from './remote-model-client';
import type { IRemoteConnectionRow } from './remote-connection.repository';
import { openModelCredential } from './remote-model-secret';

/** Имя не верифицируемо: нет списка, отказ в доступе, сетевой сбой или нет ключа. Не блокирует сохранение. */
export const REMOTE_MODEL_NAME_UNVERIFIED =
    'Имя модели не проверено: список моделей удалённого API (GET /v1/models) недоступен.';

/** Несовпадение имени со списком шлюза: сохранение отклоняется (fail-closed), ошибка несёт все доступные имена. */
export function remoteModelNameMismatch(
    modelId: string,
    modelName: string,
    availableModels: string[],
): BadRequestException {
    return new BadRequestException({
        code: 'REMOTE_MODEL_NAME_MISMATCH',
        modelId,
        modelName,
        availableModels,
        message:
            `Модель «${modelName}» не найдена на удалённом API.` +
            (availableModels.length
                ? ` Доступные имена: ${availableModels.join(', ')}.`
                : ' Список моделей на удалённом API пуст.'),
    });
}

/**
 * 8.18: сверка имени модели со списком шлюза (GET /v1/models) перед записью.
 * Несовпадение (включая явный пустой список работающего шлюза) — ошибка с доступными именами;
 * недоступный список, сетевой сбой, отказ в доступе или отсутствие ключа — предупреждение (degraded).
 * При authMode 'none' вызывать не нужно: без ключа проверка невозможна.
 */
export async function checkRemoteModelName(args: {
    pool: Pool;
    client: Pick<RemoteModelClient, 'listModels'>;
    model: Pick<IModel, 'id' | 'runtime'>;
    modelName: string;
    baseUrl: string;
    authMode: TRemoteAuthMode;
    actor: string;
    head?: IRemoteConnectionRow | null;
}): Promise<{ warning?: string }> {
    const { pool, client, model, modelName, baseUrl, authMode, actor, head } = args;
    if (authMode === 'none') return {};
    const providerId = remoteProviderId(model, { base_url: baseUrl });
    let personalKey: string | undefined;
    const db = await pool.connect();
    try {
        const credential = await readUserCredential(db, model.id, providerId, actor);
        if (credential?.credential)
            personalKey = openUserCredential(
                credential.credential,
                actor,
                providerId,
                credential.revision,
                process.env,
            );
    } catch {
        personalKey = undefined;
    } finally {
        db.release();
    }
    const names = await client.listModels(baseUrl, personalKey ?? readLegacyConnectionKey(head));
    if (names === null) return { warning: REMOTE_MODEL_NAME_UNVERIFIED };
    if (!names.includes(modelName)) throw remoteModelNameMismatch(model.id, modelName, names);
    return {};
}

/** Прежний общий секрет — допустимый ключ шлюза; нечитаемый секрет — деградация, а не ошибка. */
function readLegacyConnectionKey(head: IRemoteConnectionRow | null | undefined): string | undefined {
    if (!head || head.revoked_at || head.credential_kind === 'none') return undefined;
    try {
        if (head.credential_kind === 'stored' && head.credential)
            return openModelCredential(head.credential, head.model_id, Number(head.revision), process.env);
        if (head.credential_kind === 'environment' && head.credential_env)
            return process.env[head.credential_env] || undefined;
    } catch {
        return undefined;
    }
    return undefined;
}
