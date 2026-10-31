import { BadRequestException } from '@nestjs/common';
import type {
    RemoteRuntimeAsset,
    RuntimeAdapter,
    RuntimeSource,
    RuntimeTarget,
} from '../../../shared/tool-runtime-source.cjs';
import type { PythonSourcePlan } from '../../../shared/python-source-plan.cjs';
import { validateRuntimeSource } from '../../../shared/tool-runtime-source.cjs';
import { portablePath } from '../../../shared/runtime-artifacts.cjs';
export const uploadLimit = 256 * 1024 ** 2;
export const uploadId = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export interface UploadIntent {
    requestKey: string;
    name: string;
    bytes: number;
    sha256: string;
}
export interface UploadBuildSource {
    type: 'upload';
    uploadId: string;
    sha256: string;
    bytes: number;
    entrypoint: string;
}
export interface UploadChoice {
    entrypoint: string;
    adapter: RuntimeAdapter;
    targets: RuntimeTarget[];
    runtimeEntrypoint?: string;
    python?: PythonSourcePlan;
    runtimeAssets?: Partial<Record<RuntimeTarget, RemoteRuntimeAsset>>;
}
export interface UploadMetadata {
    candidates: string[];
    choices: UploadChoice[];
    entrypoint: string;
    name?: string;
    description?: string;
    supportedTargets?: RuntimeTarget[];
    adapter?: RuntimeAdapter;
    requiresEntrypointChoice: boolean;
    runnableKinds: ['mcp'];
}
export interface UploadRow {
    id: string;
    actor: string;
    request_key: string;
    request_hash: string;
    name: string;
    bytes: string;
    sha256: string;
    format: 'zip' | 'tar.gz' | 'file';
    state: 'WAITING' | 'UPLOADING' | 'READY' | 'CANCELLED';
    auth_epoch: string;
    lease_token: string | null;
    metadata: UploadMetadata | null;
    created_at: Date;
    expires_at: Date;
    updated_at: Date;
}
export interface PinnedUploadSource extends UploadBuildSource {
    format: UploadRow['format'];
    runtimeSource: RuntimeSource;
}
export const uploadView = (row: UploadRow) => ({
    id: row.id,
    requestKey: row.request_key,
    name: row.name,
    bytes: Number(row.bytes),
    sha256: row.sha256,
    state: row.state,
    expiresAt: row.expires_at,
    ...(row.metadata ? { metadata: row.metadata } : {}),
});
/** Binary bytes never enter the JSON control plane. */
export function validateUploadIntent(value: unknown): UploadIntent {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new BadRequestException('Нужны имя, размер, SHA-256 и UUID загрузки.');
    const raw = value as Record<string, unknown>;
    if (
        Object.keys(raw).some((key) => !['requestKey', 'name', 'bytes', 'sha256'].includes(key)) ||
        !uploadId(raw.requestKey) ||
        typeof raw.name !== 'string' ||
        !portablePath(raw.name) ||
        raw.name.includes('/') ||
        raw.name.length > 240 ||
        !Number.isSafeInteger(raw.bytes) ||
        Number(raw.bytes) < 1 ||
        Number(raw.bytes) > uploadLimit ||
        typeof raw.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(raw.sha256)
    )
        throw new BadRequestException(
            'Выберите готовый ZIP/TAR.GZ или исполняемый файл до 256 МиБ; нужны точные размер и SHA-256.',
        );
    if (/\.(?:sh|bash|zsh|bat|cmd|ps1)$/i.test(raw.name))
        throw new BadRequestException('Сценарий установки не является автономной поставкой.');
    return raw as unknown as UploadIntent;
}
export function validateUploadBuildSource(value: Record<string, unknown>): UploadBuildSource {
    if (
        Object.keys(value).some((key) => !['type', 'uploadId', 'sha256', 'bytes', 'entrypoint'].includes(key)) ||
        value.type !== 'upload' ||
        !uploadId(value.uploadId) ||
        typeof value.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.sha256) ||
        !Number.isSafeInteger(value.bytes) ||
        Number(value.bytes) < 1 ||
        Number(value.bytes) > uploadLimit ||
        typeof value.entrypoint !== 'string' ||
        !portablePath(value.entrypoint)
    )
        throw new BadRequestException('Нужны проверенная загрузка, SHA-256, размер и выбранный файл запуска.');
    return {
        type: 'upload',
        uploadId: value.uploadId.toLowerCase(),
        sha256: value.sha256,
        bytes: Number(value.bytes),
        entrypoint: value.entrypoint,
    };
}
export function uploadRuntime(choice: UploadChoice): RuntimeSource {
    const app = { directory: '.', entrypoint: choice.entrypoint };
    return validateRuntimeSource({
        type: 'runtime',
        adapter: choice.adapter,
        assets: Object.fromEntries(
            choice.targets.map((target) => [
                target,
                {
                    app,
                    ...(choice.python
                        ? { runtime: choice.runtimeAssets?.[target] }
                        : choice.runtimeEntrypoint
                          ? { runtime: { directory: '.', entrypoint: choice.runtimeEntrypoint } }
                          : {}),
                },
            ]),
        ),
        ...(choice.python ? { python: choice.python } : {}),
    });
}
