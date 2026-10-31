import type { Package } from '../../bridge/package.js';
import type { InstallSet } from '../../bridge/install-set.js';
import { verify } from '../../bridge/package.js';
import { api, readState, type Credentials } from '../../bridge/state.js';
import { projectFolder, projectBindingId, projectInstanceId } from '../../bridge/workspace.js';
import { inspectInstallation } from '../../bridge/installation-inspection.js';
import { assertInspectionIdentity } from '../../bridge/inspection-identity.js';
import { parseLocalConfiguration, readMcpConfiguration } from '../local-configuration/index.js';
import {
    normalizeQuirksLimits,
    normalizeQuirksReceipt,
    supportsLearningQuirks,
    type QuirksReceipt,
} from './contract.js';
import { readQuirksSource } from './source.js';

export interface LearningQuirksJob {
    id: string;
    projectId: string;
    lease: string;
    payload: Record<string, unknown>;
}
type Transport = (input: unknown) => Promise<unknown>;
/** The private transport carries source text; the queue completion contains only bounded counts and digest. */
export async function runProjectLearningQuirksJob(
    job: LearningQuirksJob,
    deviceId: string,
    authorize: () => Promise<void>,
    update?: (percent: number, message: string) => Promise<unknown>,
    send: Transport = (input) => api('learning-quirks/import', input),
): Promise<QuirksReceipt> {
    const pkg = structuredClone(job.payload.package) as Package;
    verify(pkg);
    if (!supportsLearningQuirks(pkg))
        throw new Error('Обновите OpenCodeRAG из каталога для безопасного сбора кварков.');
    const bindingId = String(job.payload.bindingId),
        instanceId = String(job.payload.instanceId),
        root = await projectFolder(job.projectId);
    const set = job.payload.installSet as InstallSet | undefined;
    const current = async () => {
        await authorize();
        if (
            (await projectFolder(job.projectId)) !== root ||
            (await projectBindingId(job.projectId)) !== bindingId ||
            (await projectInstanceId(job.projectId)) !== instanceId ||
            (await readState<Credentials>('credentials'))?.deviceId !== deviceId
        )
            throw new Error('Компьютер или папка проекта изменились. Повторите сбор из текущей установки.');
        const inspection = await inspectInstallation(job.projectId, pkg);
        assertInspectionIdentity(inspection, job.projectId, bindingId, pkg);
        if (inspection.state !== 'checked' || inspection.status !== 'synced')
            throw new Error('Проверьте файлы установленного OpenCodeRAG перед сбором кварков.');
    };
    const configuration = async () => {
        await current();
        const revisions = job.payload.configurationRevisions as
            Array<{ assetId: string; manifest: string; revision: string | null }> | undefined;
        if (!parseLocalConfiguration(pkg)) {
            if (!Array.isArray(revisions) || revisions.length) throw new Error('Настройка установки изменилась.');
            return null;
        }
        const found = revisions?.find(
            (item) => item.assetId === pkg.plugin.id && item.manifest === pkg.manifest.sha256,
        );
        const actual = await readMcpConfiguration(job.projectId, pkg, set, current);
        if (!found || actual.revision !== found.revision)
            throw new Error('Настройка RAG изменилась. Обновите статус и повторите сбор.');
        return actual.revision;
    };
    const revision = await configuration();
    const source = await readQuirksSource(root, current, normalizeQuirksLimits(job.payload.quirksLimits));
    await update?.(40, 'Кварки проверены. Передаём сообщённый опыт проекта.');
    await source.assertCurrent();
    if ((await configuration()) !== revision) throw new Error('Настройка RAG изменилась до передачи.');
    const receipt = normalizeQuirksReceipt(
        await send({
            jobId: job.id,
            lease: job.lease,
            projectId: job.projectId,
            bindingId,
            instanceId,
            source: { jsonl: source.jsonl, fileSha256: source.fileSha256, configurationRevision: revision },
        }),
    );
    if (receipt.fileSha256 !== source.fileSha256 || receipt.sourceCount !== source.records.length)
        throw new Error('Сервер не подтвердил точный источник кварков. Повтор безопасен.');
    // A partial receipt is returned to the worker as a failed completion, preserving its safe-retry counts.
    return receipt;
}
