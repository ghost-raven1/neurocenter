import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { securityEvent } from '../access/security-events';
import { projectAssetColumns, type IProjectPinRow } from '../catalog/project-asset-pins';
import type { IAgentExtension, IProjectAgent } from '../../../shared/project-agents.cjs';
import { agentId as validAgentId, sha } from './agent-validation';

type TDb = Pick<PoolClient, 'query'>;
export type TAssetKind = IAgentExtension['assetKind'];
const KINDS: readonly TAssetKind[] = ['mcp', 'plugin', 'skill'];
const isKind = (value: unknown): value is TAssetKind => KINDS.includes(value as TAssetKind);
const isUuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const identifier = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const projectIdOk = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const actorOk = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 320 && !/[\x00-\x1f\x7f]/.test(value);

const agentMissing = () =>
    new ConflictException(
        'Агент не добавлен в проект. Сначала добавьте агента в проект, затем настройте его расширения.',
    );
/** Fail-closed: an asset that is not in the project's approved kit (FR-202) never reaches an agent. */
const notInApprovedKit = () =>
    new ConflictException(
        'Расширение не входит в одобренный каталог проекта. Сначала назначьте ассет проекту (точный комплект), затем закрепите его за агентом.',
    );
const kitMismatch = () =>
    new ConflictException(
        'Расширение отсутствует в точном комплекте агента или закреплено в другой версии. Доступ закрыт: только одобренный каталог и активные эксперименты.',
    );

export interface IKitRow {
    agent_id: string;
    asset_id: string;
    asset_kind: string;
    asset_version: number;
    asset_manifest: string;
    origin: 'approved' | 'experimental';
}
/** Approved pins are rechecked against the current project pin; a drifted pin is not an approved exact version. */
export const KIT_SQL = `SELECT p.agent_id AS agent_id,p.asset_id AS asset_id,p.asset_kind AS asset_kind,pa.asset_version AS asset_version,pa.asset_manifest AS asset_manifest,'approved'::text AS origin
FROM agent_extension_pins p
JOIN project_assets pa ON pa.project_id=p.project_id AND pa.asset_id=p.asset_id AND pa.asset_kind=p.asset_kind
WHERE p.project_id=$1 AND pa.asset_version IS NOT NULL AND pa.asset_manifest IS NOT NULL
UNION ALL
SELECT e.agent_id,e.asset_id,e.asset_kind,e.declared_version,e.declared_manifest,'experimental'::text
FROM agent_extension_experiments e
WHERE e.project_id=$1 AND e.expires_at>now() AND e.revoked_at IS NULL`;

/** Canonical per-agent kit: approved pins win over experiments for the same asset. */
export function resolveKitRows(rows: IKitRow[]): IAgentExtension[] {
    const approved = new Set(
        rows.filter((row) => row.origin === 'approved').map((row) => row.asset_kind + ':' + row.asset_id),
    );
    return rows
        .filter((row) => row.origin === 'approved' || !approved.has(row.asset_kind + ':' + row.asset_id))
        .map((row) => ({
            assetId: row.asset_id,
            assetKind: row.asset_kind as TAssetKind,
            version: Number(row.asset_version),
            manifest: row.asset_manifest,
            origin: row.origin,
        }))
        .sort((a, b) => (a.assetKind + ':' + a.assetId < b.assetKind + ':' + b.assetId ? -1 : 1));
}
/**
 * Attach per-agent kits to normalized agent rows. Rows without extensions are returned untouched so
 * byte-identical payloads are produced for projects without a tool profile (no spurious stale jobs).
 */
export function withExtensionKits(agents: IProjectAgent[], kits: Map<string, IAgentExtension[]>): IProjectAgent[] {
    return agents.map((agent) => {
        const extensions = kits.get(agent.id);
        return extensions && extensions.length ? { ...agent, extensions } : agent;
    });
}
/** All per-agent kits of a project in one read; empty map means no tool profile is configured. */
export async function agentExtensionKits(db: TDb, projectId: string): Promise<Map<string, IAgentExtension[]>> {
    const rows = (await db.query<IKitRow>(KIT_SQL, [projectId])).rows;
    const byAgent = new Map<string, IKitRow[]>();
    for (const row of rows) {
        const list = byAgent.get(row.agent_id);
        if (list) list.push(row);
        else byAgent.set(row.agent_id, [row]);
    }
    const result = new Map<string, IAgentExtension[]>();
    for (const [agent, rows] of byAgent) result.set(agent, resolveKitRows(rows));
    return result;
}
/** The agent's exact extension set: approved pins + active, non-expired, non-revoked experiments. */
export async function resolveAgentExtensionKit(
    db: TDb,
    projectId: string,
    agentId: string,
): Promise<IAgentExtension[]> {
    const kits = await agentExtensionKits(db, projectId);
    return kits.get(agentId) ?? [];
}
/** Fail-closed gate for runtime consumers: the extension must be present in the resolved exact kit. */
export function assertExtensionInKit(
    kit: IAgentExtension[],
    ref: { assetId: string; assetKind: TAssetKind; version: number; manifest: string },
): IAgentExtension {
    const match = kit.find(
        (entry) =>
            entry.assetId === ref.assetId &&
            entry.assetKind === ref.assetKind &&
            entry.version === ref.version &&
            entry.manifest === ref.manifest,
    );
    if (!match) throw kitMismatch();
    return match;
}
/** Hosted-MCP ticket gate: with agentId the asset must belong to that agent's resolved kit. */
export async function assertAgentKitMembership(
    db: TDb,
    projectId: string,
    agentId: string,
    assetId: string,
    assetKind: TAssetKind,
    version: number,
    manifest: string,
): Promise<void> {
    const kit = await resolveAgentExtensionKit(db, projectId, agentId);
    assertExtensionInKit(kit, { assetId, assetKind, version, manifest });
}

interface IExperimentInput {
    purpose?: unknown;
    expiresAt?: unknown;
}
const EXPERIMENT_MIN_DAYS = 7;
const EXPERIMENT_MAX_DAYS = 30;
const iso = (value: Date) => value.toISOString();

/**
 * Per-agent tool profile (FR-306/AP02). Consumes the approved project kit (project_assets, epic 2)
 * and never duplicates packaging/provenance: approved pins store the project pin's exact
 * version/manifest/snapshot; experiments are device-local capability tests with a 7–30 day
 * lifetime, transactional audit, and they never enter the approved kit.
 */
export class AgentExtensionRepository {
    constructor(private readonly pool: Pool) {}
    private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
    private lock(client: PoolClient, projectId: string, agentId: string) {
        return client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            'agent-extension:' + projectId + ':' + agentId,
        ]);
    }
    private async agentAssigned(client: PoolClient, projectId: string, agentId: string): Promise<void> {
        const result = await client.query(
            'SELECT 1 FROM project_agents WHERE project_id=$1 AND agent_id=$2 AND NOT removed',
            [projectId, agentId],
        );
        if (!result.rowCount) throw agentMissing();
    }
    /** Bind a catalog asset to an agent. The asset must be in the project's approved kit (fail-closed). */
    async pin(
        projectId: string,
        agentId: string,
        assetId: string,
        kind: string,
        actor: string,
    ): Promise<IAgentExtension> {
        if (!projectIdOk(projectId) || !actorOk(actor))
            throw new BadRequestException('Передайте проект и исполнителя назначения.');
        validAgentId(agentId);
        if (!identifier(assetId)) throw new BadRequestException('Выберите ассет каталога проекта.');
        if (!isKind(kind)) throw new BadRequestException('Поддерживаются расширения mcp, plugin и skill.');
        return this.transaction(async (client) => {
            await this.lock(client, projectId, agentId);
            await this.agentAssigned(client, projectId, agentId);
            const row = (
                await client.query<IProjectPinRow>(
                    `SELECT ${projectAssetColumns} FROM project_assets
                WHERE project_id=$1 AND asset_id=$2 AND asset_kind=$3 FOR SHARE`,
                    [projectId, assetId, kind],
                )
            ).rows[0];
            // A pin without a confirmed exact version is not an approved kit entry.
            if (!row || !row.asset_version || !row.asset_manifest || !row.pin_snapshot) throw notInApprovedKit();
            const version = Number(row.asset_version),
                manifest = String(row.asset_manifest);
            await client.query(
                `INSERT INTO agent_extension_pins(project_id,agent_id,asset_id,asset_kind,asset_version,asset_manifest,pin_snapshot,added_by)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8)
                ON CONFLICT(project_id,agent_id,asset_id,asset_kind)
                DO UPDATE SET asset_version=EXCLUDED.asset_version,asset_manifest=EXCLUDED.asset_manifest,pin_snapshot=EXCLUDED.pin_snapshot`,
                [projectId, agentId, assetId, kind, version, manifest, JSON.stringify(row.pin_snapshot), actor],
            );
            return { assetId, assetKind: kind as TAssetKind, version, manifest, origin: 'approved' };
        });
    }
    /** Remove the binding; the project kit itself is untouched. */
    async unpin(projectId: string, agentId: string, assetId: string, kind: string, actor: string): Promise<boolean> {
        if (!projectIdOk(projectId) || !actorOk(actor))
            throw new BadRequestException('Передайте проект и исполнителя назначения.');
        validAgentId(agentId);
        if (!identifier(assetId) || !isKind(kind)) throw new BadRequestException('Выберите ассет каталога проекта.');
        return this.transaction(async (client) => {
            await this.lock(client, projectId, agentId);
            const result = await client.query(
                'DELETE FROM agent_extension_pins WHERE project_id=$1 AND agent_id=$2 AND asset_id=$3 AND asset_kind=$4',
                [projectId, agentId, assetId, kind],
            );
            return Boolean(result.rowCount);
        });
    }
    /**
     * Device-local capability test. Not part of the approved kit; lifetime is 7–30 days and
     * enabling is recorded in the common audit journal transactionally with the write.
     */
    async enableExperiment(
        projectId: string,
        agentId: string,
        deviceId: string,
        assetId: string,
        kind: string,
        declaredVersion: number,
        declaredManifest: string,
        actor: string,
        input: IExperimentInput = {},
    ): Promise<IAgentExtension & { purpose: string; expiresAt: string }> {
        if (!projectIdOk(projectId) || !actorOk(actor))
            throw new BadRequestException('Передайте проект и исполнителя назначения.');
        validAgentId(agentId);
        if (!isUuid(deviceId))
            throw new BadRequestException(
                'Выберите подключённый компьютер, на котором находится локальное расширение.',
            );
        if (!identifier(assetId)) throw new BadRequestException('Выберите локальное расширение.');
        if (!isKind(kind)) throw new BadRequestException('Поддерживаются расширения mcp, plugin и skill.');
        if (!Number.isSafeInteger(declaredVersion) || Number(declaredVersion) < 1)
            throw new BadRequestException('Укажите версию локального расширения.');
        if (!sha(declaredManifest)) throw new BadRequestException('Укажите SHA-256 описи локального расширения.');
        const purpose = input.purpose === undefined ? 'capability-test' : (input.purpose as unknown);
        if (
            typeof purpose !== 'string' ||
            purpose.trim().length < 1 ||
            purpose.trim().length > 256 ||
            /[\x00-\x1f\x7f]/.test(purpose)
        )
            throw new BadRequestException('Цель эксперимента — тестирование возможностей (до 256 символов).');
        const now = Date.now(),
            day = 24 * 3600 * 1000;
        let expiresAt: number;
        if (input.expiresAt === undefined) expiresAt = now + EXPERIMENT_MAX_DAYS * day;
        else if (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt)))
            throw new BadRequestException('Укажите срок эксперимента в формате ISO-даты.');
        else expiresAt = Date.parse(input.expiresAt);
        if (expiresAt < now + EXPERIMENT_MIN_DAYS * day || expiresAt > now + EXPERIMENT_MAX_DAYS * day)
            throw new BadRequestException('Срок экспериментального режима — от 7 до 30 дней от текущего момента.');
        const expires = iso(new Date(expiresAt)),
            trimmedPurpose = purpose.trim();
        return this.transaction(async (client) => {
            await this.lock(client, projectId, agentId);
            await this.agentAssigned(client, projectId, agentId);
            await client.query(
                `INSERT INTO agent_extension_experiments(project_id,agent_id,device_id,asset_id,asset_kind,declared_version,declared_manifest,purpose,expires_at,added_by)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                ON CONFLICT(project_id,agent_id,asset_id,asset_kind)
                DO UPDATE SET device_id=EXCLUDED.device_id,declared_version=EXCLUDED.declared_version,declared_manifest=EXCLUDED.declared_manifest,purpose=EXCLUDED.purpose,expires_at=EXCLUDED.expires_at,revoked_at=NULL`,
                [
                    projectId,
                    agentId,
                    deviceId,
                    assetId,
                    kind,
                    Number(declaredVersion),
                    declaredManifest,
                    trimmedPurpose,
                    expires,
                    actor,
                ],
            );
            const detail = {
                projectId,
                agentId,
                deviceId,
                assetId,
                assetKind: kind,
                declaredVersion: Number(declaredVersion),
                declaredManifest,
                purpose: trimmedPurpose,
                expiresAt: expires,
                origin: 'experimental',
                revoked: false,
            };
            await securityEvent(client, {
                actor,
                action: 'agent.extensions.experimental-enable',
                resourceId: `${projectId} · ${agentId} · ${kind} · ${assetId}`,
                before: null,
                after: detail,
            });
            return {
                assetId,
                assetKind: kind as TAssetKind,
                version: Number(declaredVersion),
                manifest: declaredManifest,
                origin: 'experimental',
                purpose: trimmedPurpose,
                expiresAt: expires,
            };
        });
    }
    /** Revoke a capability test; the audit record stays with the revoked flag. */
    async revokeExperiment(
        projectId: string,
        agentId: string,
        assetId: string,
        kind: string,
        actor: string,
    ): Promise<void> {
        if (!projectIdOk(projectId) || !actorOk(actor))
            throw new BadRequestException('Передайте проект и исполнителя назначения.');
        validAgentId(agentId);
        if (!identifier(assetId) || !isKind(kind)) throw new BadRequestException('Выберите локальное расширение.');
        return this.transaction(async (client) => {
            await this.lock(client, projectId, agentId);
            const row = (
                await client.query<{
                    device_id: string;
                    asset_id: string;
                    asset_kind: string;
                    declared_version: number;
                    declared_manifest: string;
                    purpose: string;
                    expires_at: Date | string;
                    revoked_at: Date | string | null;
                }>(
                    `UPDATE agent_extension_experiments SET revoked_at=now()
                WHERE project_id=$1 AND agent_id=$2 AND asset_id=$3 AND asset_kind=$4 AND revoked_at IS NULL
                RETURNING device_id,asset_id,asset_kind,declared_version,declared_manifest,purpose,expires_at,revoked_at`,
                    [projectId, agentId, assetId, kind],
                )
            ).rows[0];
            if (!row)
                throw new NotFoundException(
                    'Эксперимент не найден или уже отозван. Проверьте список расширений агента.',
                );
            const base = {
                projectId,
                agentId,
                deviceId: row.device_id,
                assetId: row.asset_id,
                assetKind: row.asset_kind,
                declaredVersion: Number(row.declared_version),
                declaredManifest: row.declared_manifest,
                purpose: row.purpose,
                expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
                origin: 'experimental',
            };
            await securityEvent(client, {
                actor,
                action: 'agent.extensions.experimental-revoke',
                resourceId: `${projectId} · ${agentId} · ${row.asset_kind} · ${row.asset_id}`,
                before: { ...base, revoked: false },
                after: {
                    ...base,
                    revoked: true,
                    revokedAt: row.revoked_at instanceof Date ? row.revoked_at.toISOString() : String(row.revoked_at),
                },
            });
        });
    }
}
