import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { RoleDb } from './system-role.repository';
import { roleHash } from './system-role.definitions';
import { roleObject } from './system-role.validation';
const invalid = (): never => {
    throw new ConflictException('Выберите актуальный доверенный результат проверки источника.');
};
const text = (value: unknown, bytes = 256): value is string =>
    typeof value === 'string' && !!value && Buffer.byteLength(value) <= bytes && !/[\x00-\x1f]/.test(value);
/** Inspection metadata is evidence of discovery only; the existing build owner still verifies source and runtime. */
export async function readRolePackageSource(
    db: RoleDb,
    id: string,
    actor: string,
    project: string | null,
    dialog?: string,
) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) return invalid();
    const row = (
        await db.query<{ dialog_id: string; descriptor: unknown; pin: string }>(
            `SELECT s.dialog_id,s.descriptor,s.pin FROM system_role_dialog_sources s JOIN system_role_dialogs d ON d.id=s.dialog_id
        WHERE s.id=$1 AND s.owner_email=$2 AND d.owner_email=$2 AND d.project_id IS NOT DISTINCT FROM $3 AND s.expires_at>now()`,
            [id, actor, project],
        )
    ).rows[0];
    if (!row || (dialog && row.dialog_id !== dialog))
        throw new ForbiddenException('Источник не относится к этому пользователю, проекту и диалогу либо истёк.');
    const value = row.descriptor;
    if (
        !roleObject(value) ||
        Object.keys(value).some(
            (key) =>
                ![
                    'type',
                    'name',
                    'package',
                    'version',
                    'url',
                    'commit',
                    'subdirectory',
                    'entrypoint',
                    'candidates',
                    'supportedTargets',
                    'archiveSha256',
                ].includes(key),
        ) ||
        Buffer.byteLength(JSON.stringify(value)) > 32768 ||
        !['npm', 'repository'].includes(String(value.type)) ||
        !text(value.name) ||
        !text(value.entrypoint, 500) ||
        !Array.isArray(value.candidates) ||
        value.candidates.length > 100 ||
        value.candidates.some((path) => !text(path, 500)) ||
        !Array.isArray(value.supportedTargets) ||
        value.supportedTargets.length > 8 ||
        value.supportedTargets.some((target) => !text(target, 80)) ||
        (value.archiveSha256 !== undefined &&
            (typeof value.archiveSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.archiveSha256))) ||
        roleHash(value) !== row.pin
    )
        return invalid();
    if (
        value.type === 'npm' &&
        (!text(value.package) ||
            !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(value.package) ||
            !text(value.version, 80) ||
            !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(value.version))
    )
        return invalid();
    if (value.type === 'repository') {
        if (!text(value.url, 2048) || !text(value.commit, 40) || !/^[a-f0-9]{40}$/.test(value.commit)) return invalid();
        let url: URL;
        try {
            url = new URL(value.url);
        } catch {
            return invalid();
        }
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return invalid();
    }
    if (value.subdirectory !== undefined && !text(value.subdirectory, 500)) return invalid();
    return { descriptor: value, pin: row.pin, dialogId: row.dialog_id };
}
