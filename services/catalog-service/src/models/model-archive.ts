import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { securityEvent } from '../access/security-events';
import { modelFromRow, nextModelRevision, saveModelVersion, type IModelRow } from './model-history';

/** Архив не удаляет версии и настройки inference; снятие project refs — отдельный выбор главного админа. */
export async function archiveModelWithClient(client: PoolClient, id: string, expectedRevision: number, actor: string,
    options: { removeProjectRefs?: boolean; requireUnassigned?: boolean } = {}): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('asset-management:model:'||$1,0))", [id]);
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended('neurocenter:model-hosting',0)) AS locked");
    if (!lock.rows[0]?.locked) { throw new ConflictException('Сейчас выполняется операция хостинга модели. Дождитесь её завершения.'); }
    const result = await client.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 FOR UPDATE', [id]);
    if (!result.rows[0]) { throw new NotFoundException('Модель отсутствует в каталоге.'); }
    const current = modelFromRow(result.rows[0]);
    if (current.archivedAt) { return; }
    if (current.revision !== expectedRevision) { throw new ConflictException('Карточка модели изменилась. Обновите сведения перед архивированием.'); }
    if (options.requireUnassigned && (await client.query('SELECT 1 FROM project_models WHERE model_id=$1 LIMIT 1', [id])).rows.length) {
        throw new ConflictException('Модель используется в проектах. Откройте проверку последствий удаления и выберите, сохранять ли подключения.');
    }
    if (options.removeProjectRefs) {
        const active = await client.query<{ id: string; name: string }>('SELECT p.id,p.name FROM project_embedding_settings e JOIN projects p ON p.id=e.project_id WHERE e.model_id=$1 ORDER BY p.id', [id]);
        if (active.rows.length) throw new ConflictException({ message: 'Модель используется текущими индексами. Сначала выберите другую модель или отключите эмбеддинги этих проектов; можно убрать только из общего каталога, сохранив их работу.', projects: active.rows });
    }
    await saveModelVersion(client, result.rows[0]);
    if (options.removeProjectRefs) { await client.query('DELETE FROM project_models WHERE model_id=$1', [id]); }
    const revision=await nextModelRevision(client,id,current.revision);
    const updated = await client.query<IModelRow>('UPDATE model_catalog SET archived_at=now(),revision=$2,updated_at=now() WHERE id=$1 RETURNING *', [id,revision]);
    if (!updated.rows[0]) { throw new ConflictException('Сервер не подтвердил архивирование модели.'); }
    await saveModelVersion(client, updated.rows[0]);
    await securityEvent(client, { actor, action: 'model.archive', resourceId: id, before: current,
        after: { ...modelFromRow(updated.rows[0]), removedProjectRefs: options.removeProjectRefs === true } });
}
