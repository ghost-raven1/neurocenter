import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { IDevice, DeviceStore } from './device-store';
import type { IPackage } from '../catalog/bundle-package';
import { verifyPackage } from '../catalog/bundle-package';
import { projectAssetColumns, checkedProjectPackage, type IProjectPinRow } from '../catalog/project-asset-pins';
import { ROLES, type IAccessClaims } from '../access/access.model';
import { assertAgentKitMembership } from '../agents/agent-extension-kit';
import { hasDeviceJobPermission } from './device-job-access';
import { assertContractBridge, assertManagedBridge, managedBinding } from './device-compatibility';
import { normalizeRuntimeArtifacts, runtimeDescriptorDigest } from '../../../shared/runtime-artifacts.cjs';
import { runtimeArtifactTarget } from './runtime-host-target';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';

export interface IHostedMcpSession {
    deviceId: string;
    projectId: string;
    assetId: string;
    version: number;
    manifest: string;
    /** FR-306: when present the asset must belong to this agent's resolved extension kit. */
    agentId?: string;
}
interface ISessionInput extends IHostedMcpSession {
    artifactSha256: string;
}
const uuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const text = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x20\x7f]/.test(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const agentIdOk = (value: unknown): value is string =>
    typeof value === 'string' && /^agent-[a-z0-9][a-z0-9-]{0,120}$/.test(value);
const mismatch = () =>
    new ConflictException(
        'Пакет хоста изменился или больше не назначен проекту. Повторите установку актуальной версии.',
    );
/** The ticket carries identifiers only; credentials and arbitrary package bytes cannot extend its access. */
export function hostedMcpSessionInput(value: unknown): ISessionInput {
    const body = value as Partial<ISessionInput> | null;
    if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        ![
            'artifactSha256,assetId,deviceId,manifest,projectId,version',
            'agentId,artifactSha256,assetId,deviceId,manifest,projectId,version',
        ].includes(Object.keys(body).sort().join(',')) ||
        !uuid(body.deviceId) ||
        !text(body.projectId, 200) ||
        !text(body.assetId, 512) ||
        !Number.isSafeInteger(body.version) ||
        Number(body.version) < 1 ||
        !sha(body.manifest) ||
        !sha(body.artifactSha256) ||
        (body.agentId !== undefined && !agentIdOk(body.agentId))
    )
        throw new BadRequestException('Нужна точная сессия управляемого MCP. Повторите установку.');
    return body as ISessionInput;
}
async function deviceProject(db: PoolClient, id: string, projectId: string): Promise<IDevice> {
    const device = (
        await db.query<IDevice>(
            'SELECT * FROM bridge_devices WHERE id=$1 AND NOT revoked AND expires_at>now() FOR SHARE',
            [id],
        )
    ).rows[0];
    if (!device) throw new ForbiddenException('Подключение компьютера отозвано или истекло.');
    const user = (
        await db.query<{ enabled: boolean; is_main_admin: boolean }>(
            'SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',
            [device.email],
        )
    ).rows[0];
    if (!user?.enabled) throw new ForbiddenException('Учётная запись отключена.');
    const projects = (
        await db.query<IAccessClaims['projects'][number]>(
            `SELECT pm.project_id AS "projectId",p.name AS "projectName",pm.role FROM project_members pm
        JOIN projects p ON p.id=pm.project_id WHERE lower(pm.principal_name)=$1 FOR SHARE OF pm,p`,
            [device.email],
        )
    ).rows;
    const claims: IAccessClaims = {
        email: device.email,
        projects,
        userRoles: ROLES.filter((role) =>
            role === 'Главный админ' ? user.is_main_admin : projects.some((project) => project.role === role),
        ),
        pluginIds: [],
        skillPaths: [],
    };
    if (!hasDeviceJobPermission(claims, device.role, device.role, projectId, 2))
        throw new ForbiddenException('Хост MCP требует доступа разработчика к выбранному проекту.');
    if (!(await db.query('SELECT id FROM projects WHERE id=$1 FOR SHARE', [projectId])).rowCount)
        throw new ForbiddenException('Проект недоступен.');
    assertManagedBridge(device.report);
    managedBinding(device.report, projectId);
    return device;
}
interface IApprovedHostPackage {
    package: IPackage;
    /** Издательская версия контракта из закреплённого дескриптора; отсутствует у назначений до AD-13. */
    contractVersion?: string;
}
async function approvedPackage(
    db: PoolClient,
    projectId: string,
    assetId: string,
    version: number,
    manifest: string,
): Promise<IApprovedHostPackage> {
    const row = (
        await db.query<IProjectPinRow>(
            `SELECT ${projectAssetColumns} FROM project_assets
        WHERE project_id=$1 AND asset_kind='mcp' AND asset_id=$2 FOR SHARE`,
            [projectId, assetId],
        )
    ).rows[0];
    if (!row) throw mismatch();
    const pkg = checkedProjectPackage(row);
    if (pkg.plugin.kind !== 'mcp' || pkg.plugin.version !== version || pkg.manifest.sha256 !== manifest)
        throw mismatch();
    // AD-16: retired-версия не стартует в mcp-host — и при новом authorize, и в live re-check
    // (authorizeHostedMcpSession), билет уже запущенной сессии гаснет при следующем re-check.
    const versionStatus = (
        await db.query<{ status: string }>(
            'SELECT status FROM ai_plugin_versions WHERE ai_plugin_id=$1 AND version=$2',
            [assetId, version],
        )
    ).rows[0];
    if (!versionStatus) throw mismatch();
    if (versionStatus.status === 'retired')
        throw new ForbiddenException(
            'Версия MCP отозвана площадкой. Установите актуальную версию и повторите подключение.',
        );
    const config = pkg.config;
    if (
        !config ||
        config.transport === 'remote' ||
        config.extra?.hostedMcp !== true ||
        config.extra?.localConfiguration ||
        config.args?.length ||
        (config.env && Object.keys(config.env).length)
    )
        throw new ConflictException('Этот MCP требует локальных параметров или не разрешён для хостинга площадки.');
    const raw = row.pin_snapshot?.card?.contractVersion;
    return { package: pkg, ...(typeof raw === 'string' ? { contractVersion: raw } : {}) };
}
async function hostArtifact(db: PoolClient, pkg: IPackage, expectedSha?: string) {
    const artifact = normalizeRuntimeArtifacts(pkg.config?.extra?.runtimeArtifacts).find(
        (item) => item.target === runtimeArtifactTarget(),
    );
    if (!artifact || (expectedSha !== undefined && artifact.sha256 !== expectedSha)) throw mismatch();
    const stored = (
        await db.query<{ compressed_bytes: string; unpacked_bytes: string; files_count: number }>(
            'SELECT compressed_bytes,unpacked_bytes,files_count FROM bridge_runtime_artifacts WHERE sha256=$1 FOR SHARE',
            [artifact.sha256],
        )
    ).rows[0];
    if (
        !stored ||
        Number(stored.compressed_bytes) !== artifact.compressedBytes ||
        Number(stored.unpacked_bytes) !== artifact.unpackedBytes ||
        Number(stored.files_count) !== artifact.filesCount
    )
        throw mismatch();
    return artifact;
}
async function transaction<T>(store: DeviceStore, action: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await store.pool.connect();
    try {
        await db.query('BEGIN');
        const result = await action(db);
        await db.query('COMMIT');
        return result;
    } catch (error) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        db.release();
    }
}
/** New installation admits only the current project pin and an explicitly server-hosted, parameter-free runtime. */
export async function authorizeHostedMcp(store: DeviceStore, device: IDevice, value: unknown) {
    const body = value as { projectId?: unknown; pkg?: IPackage; agentId?: unknown } | null;
    if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        !['pkg,projectId', 'agentId,pkg,projectId'].includes(Object.keys(body).sort().join(',')) ||
        !text(body.projectId, 200) ||
        !body.pkg ||
        (body.agentId !== undefined && !agentIdOk(body.agentId))
    )
        throw new BadRequestException('Нужны проект и закреплённый пакет MCP.');
    let valid = false;
    try {
        valid = verifyPackage(body.pkg);
    } catch {
        /* Invalid snapshots never reach an executable path. */
    }
    if (!valid || body.pkg.plugin.kind !== 'mcp') throw mismatch();
    // Версия фиксируется при issuance: head (undefined) не выпускает билет — перезапрос с версией.
    if (!Number.isSafeInteger(body.pkg.plugin.version) || Number(body.pkg.plugin.version) < 1)
        throw new NotFoundException('Пакет хоста MCP требует явной версии. Перезапросите дескриптор с версией.');
    // FR-306: captured before the transaction so the narrowing survives the closure.
    const sessionAgentId = agentIdOk(body.agentId) ? body.agentId : undefined;
    return transaction(store, async (db) => {
        await deviceProject(db, device.id, body.projectId as string);
        await requireFeaturesEnabled(['tool_installation']);
        const approved = await approvedPackage(
                db,
                body.projectId as string,
                body.pkg!.plugin.id,
                body.pkg!.plugin.version,
                body.pkg!.manifest.sha256,
            ),
            pkg = approved.package,
            artifact = await hostArtifact(db, pkg);
        // FR-306: an agent-scoped ticket may only expose an MCP that belongs to that agent's kit.
        if (sessionAgentId)
            await assertAgentKitMembership(
                db,
                body.projectId as string,
                sessionAgentId,
                pkg.plugin.id,
                'mcp',
                pkg.plugin.version,
                pkg.manifest.sha256,
            );
        // AD-13: сверка версии контракта и capability-диапазонов — здесь, на устройстве; рассогласование — 409 actionable.
        assertContractBridge(device.report, {
            contractVersion: approved.contractVersion,
            packageFormat: pkg.schemaVersion,
            bridgeProtocol: 2,
        });
        // AD-3: сервер выдаёт sha256 канонического descriptor-текста одобренного пакета.
        const descriptorSha256 = runtimeDescriptorDigest(
            normalizeRuntimeArtifacts(pkg.config?.extra?.runtimeArtifacts),
        );
        const session: IHostedMcpSession = {
            deviceId: device.id,
            projectId: body.projectId as string,
            assetId: pkg.plugin.id,
            version: pkg.plugin.version,
            manifest: pkg.manifest.sha256,
            ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
        };
        return {
            assetId: pkg.plugin.id,
            name: pkg.plugin.name,
            session,
            artifact: { ...artifact, executable: artifact.executable ?? false },
            descriptorSha256,
            ...(approved.contractVersion ? { contractVersion: approved.contractVersion } : {}),
        };
    });
}
/** Every ticket operation rechecks revocation and the immutable assigned package without returning secrets. */
export async function authorizeHostedMcpSession(store: DeviceStore, value: unknown): Promise<{ ok: true }> {
    const input = hostedMcpSessionInput(value);
    return transaction(store, async (db) => {
        await deviceProject(db, input.deviceId, input.projectId);
        const approved = await approvedPackage(db, input.projectId, input.assetId, input.version, input.manifest);
        await hostArtifact(db, approved.package, input.artifactSha256);
        // FR-306: an agent-scoped ticket keeps the kit membership gate on every re-check.
        if (input.agentId)
            await assertAgentKitMembership(
                db,
                input.projectId,
                input.agentId,
                input.assetId,
                'mcp',
                input.version,
                input.manifest,
            );
        if (approved.package.config?.extra?.researchMcp)
            await requireFeaturesEnabled(['research_tools', 'tool_catalog']);
        return { ok: true };
    });
}
