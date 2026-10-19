import { resolveProjectKey, type TResolveProjectKeyInput } from '../tools/resolve-project-key.js';

export interface IRagProjectIdentity {
    ok: boolean;
    projectKey?: string;
    identityVerified?: boolean;
    instanceId?: string;
    bindingId?: string;
}

/** Отправка и скачивание используют одну проверку явного экземпляра и поколения привязки. */
export async function readRagProjectIdentity(input: TResolveProjectKeyInput, cwd: string): Promise<{ raw: string; value: IRagProjectIdentity }> {
    const raw = await resolveProjectKey(input, cwd);
    return { raw, value: JSON.parse(raw) as IRagProjectIdentity };
}

export function verifiedRagProjectIdentity(value: IRagProjectIdentity, projectKey: string, expected?: IRagProjectIdentity): boolean {
    return value.ok && value.identityVerified === true && Boolean(value.instanceId && value.bindingId) && value.projectKey === projectKey
        && (!expected || value.instanceId === expected.instanceId && value.bindingId === expected.bindingId);
}

export const unverifiedRagProject = (): string => JSON.stringify({ ok: false, error: 'project-instance-unverified', migrationRequired: true,
    message: 'Подтвердите локальный экземпляр проекта на странице «Проекты» перед передачей базы знаний. Явный ID проекта не заменяет проверку папки.' });
