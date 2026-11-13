import { ConflictException } from '@nestjs/common';
import { AGENT_METHOD_WORKFLOW_JOB } from '../../../shared/agent-method-workflow.cjs';
import {
    assertAgentResultAccepted,
    normalizeVerificationIntent,
} from '../../../shared/agent-result-verification.cjs';

/**
 * FR-304: универсальный fail-closed гейт приёма результата работы агента, объявившего верификацию.
 * Результат без машины-читаемого доказательства (exit-code/покрытие по выбранным проверкам) не принимается:
 * «сделано» без верификации = отказ. Метод-воркфлоу устройств покрывает device-контракт
 * (assertAgentMethodResult), здесь он намеренно пропускается.
 */
export function assertVerifiedAgentResult(
    job: { kind: string; payload?: Record<string, unknown> },
    result: Record<string, unknown>,
    failed: boolean,
): void {
    if (job.kind === AGENT_METHOD_WORKFLOW_JOB) return;
    const declared = job.payload?.verification;
    if (declared === undefined) return;
    let intent;
    try {
        intent = normalizeVerificationIntent(declared);
    } catch {
        throw new ConflictException('Задание с верификацией имеет неподдерживаемое описание выбранных проверок.');
    }
    try {
        assertAgentResultAccepted(result, failed, intent);
    } catch {
        throw new ConflictException(
            'Результат агента не принят: нет машины-читаемого доказательства (exit-code/покрытие) по выбранным проверкам. Запустите проверки и подтвердите результат заново.',
        );
    }
}
