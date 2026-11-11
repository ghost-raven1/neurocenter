import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
    normalizeOpenCodePersonalKeyProviderUrl,
    type IOpenCodePersonalKeyPayload,
} from '../../../shared/opencode-personal-key.cjs';
import { modelFromRow, type IModelRow } from '../models/model-history';
import { canStoreModelCredential } from '../models/remote-model-secret';
import { providerConnection, readUserCredential } from '../remote-providers/remote-provider.repository';
import { remoteProviderId, remoteAuthMode } from '../remote-providers/remote-provider.identity';
import { remoteProviderAuthority } from '../remote-providers/remote-provider.authority';
import type { IRemoteProviderActor } from '../remote-providers/remote-provider.interfaces';
/** The recipient is the model's own OpenAI-compatible endpoint; the device resolves the local provider by this address. */
export async function personalKeyTarget(
    db: Pick<PoolClient, 'query'>,
    actor: IRemoteProviderActor,
    payload: IOpenCodePersonalKeyPayload,
    checkCredential = true,
) {
    await remoteProviderAuthority(db, actor, payload.modelId);
    const row = (
        await db.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 AND archived_at IS NULL FOR SHARE', [
            payload.modelId,
        ])
    ).rows[0];
    if (!row) throw new ConflictException('Модель недоступна для переноса личного ключа.');
    const model = modelFromRow(row),
        connection = await providerConnection(db, model.id),
        providerId = remoteProviderId(model, connection),
        authMode = remoteAuthMode(connection);
    let providerUrl = '';
    try {
        providerUrl = normalizeOpenCodePersonalKeyProviderUrl(connection.base_url);
    } catch {
        providerUrl = '';
    }
    if (
        model.runtime !== 'remote-openai' ||
        !providerUrl ||
        authMode === 'none' ||
        providerId !== payload.providerId ||
        Number(connection.revision) !== payload.expectedConnectionRevision ||
        !canStoreModelCredential()
    )
        throw new ConflictException('Получатель изменился или хранилище ключей недоступно. Перечитайте личный доступ.');
    const current = await readUserCredential(db, model.id, providerId, actor.email);
    if (checkCredential && (current?.revision ?? 0) !== payload.expectedCredentialRevision)
        throw new ConflictException('Личный доступ уже изменён. Перечитайте сведения перед переносом.');
    return {
        model,
        recipient: {
            ownerEmail: actor.email,
            modelId: model.id,
            modelName: model.name,
            providerId,
            providerUrl,
            connectionRevision: Number(connection.revision),
            credentialRevision: current?.revision ?? 0,
            authMode,
            canStoreKey: true as const,
        },
    };
}
