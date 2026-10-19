import { BadRequestException, ConflictException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { ProjectEmbeddingService } from '../models/project-embedding.service';
import type { IConfiguredProjectEmbedding } from '../models/project-embedding.types';
import type { Device } from './device-store';
import type { DeviceInstallations } from './device-installations';
import type { InstallPlans } from './install-plans';
import type { Job, JobInput } from './device-job.model';
import { assertLocalFeature } from './local-change-jobs';
import { ragUiJobPayload, assertRagUiJob } from './rag-ui-jobs';
import { requireFeatureEnabled } from '../features/require-feature-enabled';

export const HOSTED_RAG_KIND = 'connect-rag-model';
const fields = ['deviceId','projectId','kind','requestKey','assetId','assetKind','version','expectedManifest',
    'expectedBindingId','expectedInstanceId','expectedEmbeddingRevision','expectedEmbeddingPin'];

/** Настройка разрешена только адаптеру, который явно поддерживает приватное подключение. */
export function supportsHostedRag(pkg: {config?: {extra?: Record<string, unknown>} | null}): boolean {
    const descriptor = pkg.config?.extra?.hostedEmbedding;
    return !!descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)
        && Object.keys(descriptor).every(key => ['schemaVersion','profileSchemaVersion'].includes(key))
        && (descriptor as {schemaVersion?: unknown}).schemaVersion === 1
        && (!('profileSchemaVersion' in descriptor) || descriptor.profileSchemaVersion === 2);
}

export async function hostedRagJobPayload(embedding: ProjectEmbeddingService, installations: DeviceInstallations,
    plans: InstallPlans, device: Device, input: JobInput) {
    if (input.kind !== HOSTED_RAG_KIND) return undefined;
    if (Object.keys(input).some(key => !fields.includes(key)) || !Number.isSafeInteger(input.expectedEmbeddingRevision)
        || Number(input.expectedEmbeddingRevision) < 1 || !/^[a-f0-9]{64}$/.test(input.expectedEmbeddingPin ?? '')) {
        throw new BadRequestException('Подключение требует актуального выбора модели и точной установки OpenCodeRAG.');
    }
    assertLocalFeature(device.report, 'hosted-rag-model-v1');
    await requireFeatureEnabled('model_hosting');
    const {expectedEmbeddingRevision,expectedEmbeddingPin,...rest} = input;
    const approved = await ragUiJobPayload(installations, plans, device, {...rest,kind:'open-rag-ui'});
    if (!approved || !supportsHostedRag(approved.package)) {
        throw new ConflictException('Обновите OpenCodeRAG из каталога: эта версия ещё не поддерживает модель через мост.');
    }
    const selection = await embedding.requireCurrent(input.projectId!, expectedEmbeddingRevision, expectedEmbeddingPin);
    return {...approved,embedding:selection};
}

/** Очередь не продлевает прежний выбор модели, одобрение пакета или права на папку. */
export async function assertHostedRagJob(embedding: ProjectEmbeddingService, installations: DeviceInstallations,
    plans: InstallPlans, device: Device, job: Pick<Job,'kind'|'payload'|'project_id'>): Promise<void> {
    if (job.kind !== HOSTED_RAG_KIND) return;
    assertLocalFeature(device.report, 'hosted-rag-model-v1');
    await requireFeatureEnabled('model_hosting');
    await assertRagUiJob(installations, plans, device, {...job,kind:'open-rag-ui'});
    if (!supportsHostedRag(job.payload.package as Parameters<typeof supportsHostedRag>[0])) {
        throw new ConflictException('Версия OpenCodeRAG не поддерживает подключение через мост.');
    }
    const saved = job.payload.embedding as IConfiguredProjectEmbedding | undefined;
    if (!saved?.profile || saved.projectId !== job.project_id) throw new ConflictException('В задании отсутствует выбор модели.');
    const current = await embedding.requireCurrent(job.project_id!, saved.revision, saved.modelPin);
    if (!isDeepStrictEqual(current.profile, saved.profile)) throw new ConflictException('Профиль модели изменился. Подготовьте подключение заново.');
}

/** Публичный результат не содержит loopback URL, токен, локальный путь или тексты. */
export function assertHostedRagResult(result: Record<string,unknown>, payload: Record<string,unknown>, failed: boolean): void {
    const selection = payload.embedding as IConfiguredProjectEmbedding | undefined;
    const keys = ['status','revision','modelPin','profile','requiresRestart'];
    if (failed ? Object.keys(result).length !== 0 : !selection || Object.keys(result).length !== keys.length
        || Object.keys(result).some(key => !keys.includes(key)) || result.status !== 'connected' || result.requiresRestart !== true
        || result.revision !== selection.revision || result.modelPin !== selection.modelPin || !isDeepStrictEqual(result.profile, selection.profile)) {
        throw new ConflictException('Результат подключения не соответствует выбранной модели или содержит локальные данные.');
    }
}
