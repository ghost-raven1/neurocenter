import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';

export interface LocalChangeFile {
    path: string; operation: 'add' | 'replace' | 'remove'; beforeSha256: string | null; afterSha256: string | null;
    beforeBytes: number; afterBytes: number; binary: boolean;
}
export interface LocalChangePlan {
    schemaVersion: 1; planId: string; revision: 1; digest: string; projectId: string; bindingId: string; instanceId: string;
    assetId: string; assetKind: 'skill' | 'mcp' | 'plugin'; version: number; manifest: string;
    checkedAt: string; expiresAt: string; status: 'prepared'; files: LocalChangeFile[]; runtimeRepairRequired?: true;
}
interface Source {
    projectId: string | null; bindingId?: string; instanceId?: string;
    package?: { plugin: { id: string; kind?: string; version: number }; manifest: { sha256: string } };
}
const fields = ['schemaVersion','planId','revision','digest','projectId','bindingId','instanceId','assetId','assetKind','version','manifest','checkedAt','expiresAt','status','files'];
const fileFields = ['path','operation','beforeSha256','afterSha256','beforeBytes','afterBytes','binary'];
const exactFields = (value: object, allowed: string[]): boolean => Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key));
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Сервер принимает только ограниченные метаданные; исходники и полный diff остаются в MCP. */
export function assertLocalChangePlan(value: unknown, source: Source): asserts value is LocalChangePlan {
    const plan = value as LocalChangePlan | null;
    const fail = () => { throw new ConflictException('План изменений не соответствует установленному пакету или содержит недопустимые данные.'); };
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !exactFields(plan, plan.runtimeRepairRequired === true ? [...fields,'runtimeRepairRequired'] : fields)
        || plan.schemaVersion !== 1 || plan.revision !== 1 || plan.status !== 'prepared' || !uuid(plan.planId) || !sha(plan.digest)
        || plan.projectId !== source.projectId || plan.bindingId !== source.bindingId || !sha(plan.bindingId)
        || plan.instanceId !== source.instanceId || !uuid(plan.instanceId)
        || plan.assetId !== source.package?.plugin.id || plan.assetKind !== source.package?.plugin.kind
        || plan.version !== source.package?.plugin.version || plan.manifest !== source.package?.manifest.sha256
        || !iso(plan.checkedAt) || !iso(plan.expiresAt) || Date.parse(plan.expiresAt) <= Date.parse(plan.checkedAt)
        || Date.parse(plan.expiresAt) - Date.parse(plan.checkedAt) > 15 * 60 * 1000
        || !Array.isArray(plan.files) || plan.files.length > 512 || Buffer.byteLength(JSON.stringify(plan)) > 512 * 1024) { return fail(); }
    let total = 0;
    const paths = new Set<string>();
    for (const file of plan.files) {
        if (!file || typeof file !== 'object' || Array.isArray(file) || !exactFields(file, fileFields)
            || typeof file.path !== 'string' || !file.path || file.path.length > 1024 || /[\\:\x00-\x1f]/.test(file.path)
            || file.path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(file.path.normalize('NFC').toLowerCase())
            || !['add','replace','remove'].includes(file.operation) || typeof file.binary !== 'boolean'
            || [file.beforeBytes,file.afterBytes].some(size => !Number.isSafeInteger(size) || size < 0 || size > 4 * 1024 * 1024)
            || (file.beforeSha256 !== null && !sha(file.beforeSha256)) || (file.afterSha256 !== null && !sha(file.afterSha256))
            || (file.operation === 'add' && (file.beforeSha256 !== null || file.beforeBytes !== 0 || file.afterSha256 === null))
            || (file.operation === 'remove' && (file.afterSha256 !== null || file.afterBytes !== 0 || file.beforeSha256 === null))
            || (file.operation === 'replace' && (file.beforeSha256 === null || file.afterSha256 === null))) { return fail(); }
        paths.add(file.path.normalize('NFC').toLowerCase()); total += file.beforeBytes + file.afterBytes;
    }
    if (total > 32 * 1024 * 1024) { return fail(); }
}

export async function saveLocalChangePlan(client: PoolClient, job: { id: string; device_id: string; project_id: string | null; email: string; payload: Source }, plan: unknown,
    purpose:'repair'|'adopt'|'restore-local'='repair',sourceId?:string): Promise<void> {
    assertLocalChangePlan(plan,{...job.payload,projectId:job.project_id});
    await client.query(`INSERT INTO bridge_local_change_plans(id,device_id,project_id,email,binding_id,instance_id,preparation_job_id,revision,digest,summary,expires_at,purpose,source_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [plan.planId,job.device_id,job.project_id,job.email,
        plan.bindingId,plan.instanceId,job.id,plan.revision,plan.digest,plan,plan.expiresAt,purpose,sourceId??null]);
}
