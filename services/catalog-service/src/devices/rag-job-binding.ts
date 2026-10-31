import { ConflictException } from '@nestjs/common';
import { assertExpectedBinding, managedBinding } from './device-compatibility';

export const RAG_JOB_KINDS = ['sync-rag', 'restore-rag'];
export const RAG_GENERATION_PROTOCOL = 'project-rag-generations-v1';
/** Задание сохраняет версию wire-контракта, а обновление устройства не оживляет старый payload. */
export function assertRagJobProtocol(payload: Record<string, unknown>): void {
    if (payload.ragProtocol !== RAG_GENERATION_PROTOCOL)
        throw new ConflictException('Задание создано до обновления формата RAG. Запустите новую синхронизацию знаний.');
}

/** Старая очередь не перенаправляет индекс в другую локальную папку после перепривязки. */
export function assertRagJobBinding(
    report: Record<string, unknown>,
    projectId: string | undefined,
    expected: unknown,
): string {
    if (!Array.isArray(report.capabilities) || !report.capabilities.includes('project-rag-generations-v1')) {
        throw new ConflictException(
            'Обновите мост на странице «Начало работы» для проверки профиля индекса и безопасной синхронизации знаний.',
        );
    }
    if (report.ragSupported === false) {
        throw new ConflictException('Локальная LanceDB недоступна на выбранном компьютере.');
    }
    const bindingId = managedBinding(report, projectId);
    assertExpectedBinding(bindingId, expected, true);
    return bindingId;
}
