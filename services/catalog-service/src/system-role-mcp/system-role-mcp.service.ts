import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { SYSTEM_ROLE_MCP_LIMITS as limits, boundedMcpJson, normalizeRoleMcpTarget, normalizeRoleMcpResult, roleMcpProducer, roleMcpToolKey, systemRoleMcpDigest,
    type RoleMcpPreparedTarget, type RoleMcpTarget, type RoleMcpTargetSelection, type RoleMcpReceipt, type RoleMcpOutput } from '../../../shared/system-role-mcp.cjs';
import { ModelsService } from '../models/models.service';
import { DeviceStore } from '../devices/device-store';
import { DeviceInstallations } from '../devices/device-installations';
import { InstallPlans } from '../devices/install-plans';
import { configurationRevisionsForProbe } from '../devices/mcp-config-status';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { checkedProjectPackage, projectAssetColumns, type IProjectPinRow } from '../catalog/project-asset-pins';
import { roleRequestId } from '../system-roles/system-role.validation';
import { systemRole } from '../system-roles/system-role.definitions';
import type { RoleRunRow } from '../system-roles/system-role.types';
import type { SystemRoleMcpAccess } from './system-role-mcp.types';
import { SystemRoleMcpPolicy } from './system-role-mcp.policy';
import { SystemRoleMcpRepository } from './system-role-mcp.repository';
import { SystemRoleMcpChannel, type McpChannelFence } from './system-role-mcp.channel';
import { mcpCallContext, type McpCallRow, type McpSessionRow, type McpDiscoveryView } from './system-role-mcp.store-types';

type Db = Pick<PoolClient, 'query'>;
const exact = (raw: unknown, keys: string[]): Record<string, unknown> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) throw new BadRequestException('Проверьте поля выбранного MCP.'); return raw as Record<string, unknown>;
};
/** Generic private MCP sessions are opt-in, pinned by actual discovery, and dispatched at most once. */
@Injectable()
export class SystemRoleMcpService implements SystemRoleMcpAccess, OnModuleInit, OnApplicationShutdown {
    readonly repository: SystemRoleMcpRepository;
    readonly policy: SystemRoleMcpPolicy;
    readonly channel: SystemRoleMcpChannel;
    private readonly tasks = new Set<Promise<void>>();
    private readonly owned = new Set<string>();
    private readonly stop = new AbortController();
    private timer?: ReturnType<typeof setInterval>;
    constructor(private readonly models: ModelsService, devices: DeviceStore, installations: DeviceInstallations, plans: InstallPlans) {
        this.repository = new SystemRoleMcpRepository(models.pool); this.policy = new SystemRoleMcpPolicy(models, devices, installations, plans);
        this.channel = new SystemRoleMcpChannel(this.repository, devices, (session, db) => this.authority(session, db), (id, fence) => this.dispatch(id, fence), (id, onlyUnclaimed) => this.closeSession(id, onlyUnclaimed), session => this.executionFeatures(session));
    }
    async onModuleInit(): Promise<void> {
        await this.models.ready(); await this.expire(); this.timer = setInterval(() => { void this.expire().catch(() => undefined); }, 2500); this.timer.unref();
    }
    async onApplicationShutdown(): Promise<void> {
        this.stop.abort(); if (this.timer) clearInterval(this.timer);
        await Promise.allSettled([...this.owned].map(id => this.closeSession(id))); await Promise.allSettled([...this.tasks]);
    }
    async list(req: Request, projectId?: string) {
        await this.models.ready(); const project = this.policy.project(projectId), actor = await this.policy.roles.actor(req, project, 1);
        let enabled = true; try { await requireFeaturesEnabled(['system_role_mcp']); } catch { enabled = false; }
        const pins = (await this.models.pool.query<IProjectPinRow>(`SELECT ${projectAssetColumns} FROM project_assets WHERE project_id=$1 AND asset_kind IN ('mcp','plugin') ORDER BY asset_id LIMIT 100`, [project])).rows;
        const devices = (await this.policy.devices.list(actor)).slice(0, 20), assignments = [];
        for (const pin of pins) {
            let pkg; try { pkg = checkedProjectPackage(pin); if (!roleMcpProducer(pkg)) continue; } catch { continue; }
            const common = { assetId: pkg.plugin.id, ...(pkg.plugin.kind === 'plugin' ? { assetKind: 'plugin' as const } : {}), version: pkg.plugin.version, manifest: pkg.manifest.sha256 };
            let server: { available: boolean; reason?: string } = { available: true };
            try { await this.policy.server(pkg); } catch (error) { server = { available: false, reason: error instanceof Error ? error.message : 'Серверный runtime недоступен.' }; }
            const computers = [];
            for (const device of devices) {
                const binding = (device.report.bindings as Array<{ projectId: string; bindingId: string; instanceId: string }> | undefined)?.find(value => value.projectId === project);
                const base = { deviceId: String(device.id), name: String(device.name), bindingId: binding?.bindingId ?? '', instanceId: binding?.instanceId ?? '' };
                try {
                    if (!device.online || !binding) throw new ConflictException('Компьютер не подключён или папка проекта не связана.');
                    const delivery = await this.policy.installations.inspectionDelivery(actor, { ...base, projectId: project, assetId: common.assetId, assetKind: common.assetKind ?? 'mcp', expectedManifest: common.manifest });
                    const configurationRevisions = await configurationRevisionsForProbe(this.models.pool, actor.email, { ...base, projectId: project, packages: delivery.installSet?.packages ?? [delivery.package] });
                    const target: RoleMcpTarget = { ...common, runtime: 'device', ...base, configurationRevisions };
                    await this.policy.target(req, project, target); computers.push({ ...base, configurationRevisions, available: true });
                } catch (error) { computers.push({ ...base, configurationRevisions: [], available: false, reason: error instanceof Error ? error.message : 'Проверьте установку и настройку MCP на компьютере.' }); }
            }
            assignments.push({ ...common, name: pkg.plugin.name, server, devices: computers });
        }
        return { assignments, limits: { targets: limits.targets, selectedTools: limits.selectedTools, calls: limits.calls }, enabled };
    }
    async discover(req: Request, raw: unknown): Promise<McpDiscoveryView> {
        await this.models.ready(); const input = exact(raw, ['projectId', 'target', 'requestId']), project = this.policy.project(input.projectId), id = roleRequestId(input.requestId);
        let target: RoleMcpTarget; try { target = normalizeRoleMcpTarget(input.target, false); } catch { throw new BadRequestException('Выберите точный runtime и закреплённую версию инструмента.'); }
        const actor = await this.policy.roles.actor(req, project, 1), hash = systemRoleMcpDigest({ project, target }), old = await this.repository.discovery(id, actor.email);
        if (old) { if (old.request_hash !== hash) throw new ConflictException('Ключ обнаружения относится к другому выбору.'); return this.discovery(req, id); }
        await this.policy.roles.actor(req, project); await this.features(target);
        const delivery = await this.policy.target(req, project, target);
        const saved = await this.repository.discover(id, hash, { owner: actor.email, role: actor.activeRole, project, target, ...delivery }, async db => {
            await this.policy.roles.authorize(db, actor, project); await this.policy.target(req, project, target, db);
        });
        if (saved.created) { this.owned.add(saved.session.id); if (target.runtime === 'server') this.execute(saved.session, saved.call); }
        return this.discovery(req, id);
    }
    async discovery(req: Request, id: string): Promise<McpDiscoveryView> {
        const actor = await this.models.actor(req), row = await this.repository.discovery(roleRequestId(id), actor.email);
        if (!row) throw new NotFoundException('Обнаружение инструментов недоступно.'); await this.policy.roles.actor(req, row.project_id, 1);
        const call = await this.repository.call(row.call_id), value = call.result?.state === 'succeeded' ? call.result.value : undefined;
        const ready = value && 'tools' in value;
        return { id: row.id, state: ready ? 'ready' : ['queued', 'dispatched'].includes(call.state) ? 'pending' : 'failed', target: row.target,
            tools: ready ? value.tools : [], message: ready ? 'Список инструментов получен от выбранного MCP.' : ['queued', 'dispatched'].includes(call.state) ? 'Получаем реальные возможности выбранного MCP.' : call.result && 'message' in call.result ? call.result.message : 'Обнаружение не подтверждено. Проверьте подключение и начните новую проверку.' };
    }
    async assertAdmission(req: Request, projectId: string | null, selection: RoleMcpTargetSelection[]): Promise<void> {
        const project = this.policy.project(projectId), actor = await this.policy.roles.actor(req, project);
        for (const target of selection) {
            await this.features(target); const row = await this.repository.discovery(target.discoveryId, actor.email);
            if (!row || row.project_id !== project || new Date(row.expires_at).getTime() <= Date.now()) throw new ConflictException('Список инструментов устарел. Обновите возможности MCP и подтвердите контекст заново.');
        }
        await this.prepare(req, project, selection);
    }
    async prepare(req: Request, projectId: string | null, selection: RoleMcpTargetSelection[]): Promise<RoleMcpPreparedTarget[]> {
        const project = this.policy.project(projectId), actor = await this.policy.roles.actor(req, project), result: RoleMcpPreparedTarget[] = [];
        for (const target of selection) {
            const row = await this.repository.discovery(roleRequestId(target.discoveryId), actor.email), base = normalizeRoleMcpTarget(Object.fromEntries(Object.entries(target).filter(([key]) => !['tools', 'discoveryId'].includes(key))), false);
            if (!row || row.project_id !== project || systemRoleMcpDigest(row.target) !== systemRoleMcpDigest(base)) throw new ConflictException('Обнаружение относится к другому инструменту или контексту.');
            await this.policy.target(req, project, base);
            const call = await this.repository.call(row.call_id), value = call.result?.state === 'succeeded' ? call.result.value : undefined;
            if (!value || !('tools' in value)) throw new ConflictException('Сначала получите действительный список возможностей MCP.');
            const tools = target.tools.map(selected => { const tool = value.tools.find(item => item.name === selected.name && item.schemaDigest === selected.schemaDigest); if (!tool) throw new ConflictException('Схема выбранного инструмента изменилась. Повторите обнаружение.'); return { ...tool, toolKey: roleMcpToolKey(base, tool.name) }; });
            result.push({ target, tools });
        }
        return result;
    }
    /** Tool availability can fail locally while the role still finalizes evidence under its own authority. */
    async canContinueTools(req: Request, row: RoleRunRow): Promise<boolean> {
        const project = this.policy.project(row.project_id), actor = await this.policy.roles.actor(req, project);
        if (actor.email !== row.actor || actor.activeRole !== row.actor_role) throw new ForbiddenException('Исполнитель системного агента изменился.');
        try {
            await requireFeaturesEnabled(['system_role_mcp', 'tool_catalog', ...(row.snapshot.mcp?.some(item => item.target.runtime === 'device') ? ['computer_connections' as const] : [])]);
            for (const item of row.snapshot.mcp ?? []) {
                const target = normalizeRoleMcpTarget(Object.fromEntries(Object.entries(item.target).filter(([key]) => !['tools', 'discoveryId'].includes(key))), false);
                await this.policy.targetForActor(actor, project, target);
            }
            return true;
        } catch {
            await this.policy.roles.actor(req, project); // A concurrent core revocation remains an authorization error.
            return false;
        }
    }
    async call(req: Request, row: RoleRunRow, prepared: RoleMcpPreparedTarget[], toolKey: string, args: Record<string, unknown>, signal: AbortSignal): Promise<RoleMcpReceipt> {
        signal.throwIfAborted(); const selected = prepared.find(item => item.tools.some(tool => tool.toolKey === toolKey)), tool = selected?.tools.find(value => value.toolKey === toolKey);
        if (!selected || !tool || !row.snapshot.mcp?.some(item => item.tools.some(value => value.toolKey === toolKey && value.schemaDigest === tool.schemaDigest) && systemRoleMcpDigest(item.target) === systemRoleMcpDigest(selected.target))) throw new ConflictException('Инструмент не входит в подтверждённый контекст запуска.');
        const project = this.policy.project(row.project_id); await this.features(selected.target); await requireFeaturesEnabled([systemRole(row.agent_id).flag, ...(row.request.sourceFeature ? [row.request.sourceFeature] : [])]);
        const target = normalizeRoleMcpTarget(Object.fromEntries(Object.entries(selected.target).filter(([key]) => !['tools', 'discoveryId'].includes(key))), false), delivery = await this.policy.target(req, project, target);
        const value = boundedMcpJson(args, limits.argumentsBytes), saved = await this.repository.enqueue({ owner: row.actor, role: row.actor_role, project, target, ...delivery, run: row }, { key: toolKey, name: tool.name, digest: tool.schemaDigest, arguments: value }, (db, current) => this.policy.roles.current(req, current, db).then(() => undefined));
        this.owned.add(saved.session.id); if (target.runtime === 'server') this.execute(saved.session, saved.call, signal);
        try {
            for (;;) {
                signal.throwIfAborted(); const current = await this.repository.call(saved.call.id);
                if (!['queued', 'dispatched'].includes(current.state)) return this.receipt(current);
                if (new Date(current.deadline_at).getTime() <= Date.now()) { await this.closeSession(saved.session.id); return this.receipt(await this.repository.call(current.id)); }
                await delay(100, undefined, { signal });
            }
        } catch (error) { await this.closeSession(saved.session.id); throw error; }
    }
    async calls(req: Request, id: string): Promise<RoleMcpReceipt[]> {
        const actor = await this.models.actor(req), run = (await this.models.pool.query<RoleRunRow>('SELECT * FROM system_role_runs WHERE id=$1 AND actor=$2', [roleRequestId(id), actor.email])).rows[0];
        if (!run) throw new NotFoundException('Журнал инструментов недоступен.'); await this.policy.roles.read(req, run);
        return (await this.models.pool.query<McpCallRow>("SELECT * FROM system_role_mcp_calls WHERE run_id=$1 AND kind='call' ORDER BY created_at,id", [run.id])).rows.map(row => this.receipt(row));
    }
    async close(runId: string, leaseToken: string): Promise<void> {
        const rows = (await this.models.pool.query<{ id: string }>("SELECT id FROM system_role_mcp_sessions WHERE run_id=$1 AND lease_token=$2 AND state='open'", [runId, leaseToken])).rows;
        await Promise.allSettled(rows.map(row => this.closeSession(row.id)));
    }
    async context(id: string) {
        const call = await this.repository.call(roleRequestId(id)), session = await this.repository.session(call.session_id);
        if (session.target.runtime !== 'server' || call.state !== 'queued') throw new ConflictException('Вызов недоступен или уже отправлен.'); await this.executionFeatures(session); await this.authority(session);
        return { session: { sessionId: session.id, jobId: null, projectId: session.project_id, target: session.target, package: session.package, ...(session.install_set ? { installSet: session.install_set } : {}), deadlineAt: new Date(session.deadline_at).toISOString() }, call: { ...mcpCallContext(call), proof: call.dispatch_proof } };
    }
    async serverDispatch(raw: unknown) {
        const input = exact(raw, ['callId', 'proof']);
        return this.dispatch(roleRequestId(input.callId), undefined, input.proof);
    }
    async serverResult(raw: unknown) {
        const input = exact(raw, ['callId', 'proof', 'result']), call = await this.repository.call(roleRequestId(input.callId)), session = await this.repository.session(call.session_id);
        this.proof(session, call, input.proof);
        if (!call.dispatched_at) throw new ConflictException('Отправка инструмента не подтверждена.');
        await this.repository.finish(call.id, normalizeRoleMcpResult(input.result, call.kind));
        if (call.kind === 'list') await this.closeSession(session.id);
        return { ok: true };
    }
    async dispatch(id: string, fence?: McpChannelFence, proof?: unknown) {
        const callId = roleRequestId(id), pending = await this.repository.call(callId), source = await this.repository.session(pending.session_id);
        if (fence) this.channelFence(source, fence); else this.proof(source, pending, proof);
        await this.executionFeatures(source);
        return this.repository.dispatch(callId, async (db, session, call) => {
            if (fence) {
                this.channelFence(session, fence);
            } else this.proof(session, call, proof);
            await this.authority(session, db);
        });
    }
    private channelFence(session: McpSessionRow, fence: McpChannelFence): void {
        if (session.id !== fence.sessionId || session.worker_lease !== fence.lease || session.target.runtime !== 'device' || session.target.deviceId !== fence.deviceId) throw new ConflictException('Сессия компьютера изменилась до отправки.');
    }
    private proof(session: McpSessionRow, call: McpCallRow, proof: unknown): void {
        if (session.target.runtime !== 'server' || typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof) || !timingSafeEqual(Buffer.from(proof), Buffer.from(call.dispatch_proof))) throw new NotFoundException('Квитанция отправки MCP недоступна.');
    }
    private async authority(session: McpSessionRow, db: Db = this.models.pool): Promise<void> {
        if (session.state !== 'open' || new Date(session.deadline_at).getTime() <= Date.now() || session.target.runtime === 'device' && session.claimed_at && (!session.worker_lease_until || new Date(session.worker_lease_until).getTime() <= Date.now())) throw new ConflictException('Сессия MCP завершена или потеряла аренду.');
        const current = session.run_id ? (await db.query<RoleRunRow>("SELECT * FROM system_role_runs WHERE id=$1 AND actor=$2 AND lease_token=$3 AND state='running' AND lease_until>now() FOR NO KEY UPDATE", [session.run_id, session.owner_email, session.lease_token])).rows[0] : undefined;
        if (session.run_id && !current) throw new ConflictException('Задача системного агента отменена или завершена.');
        const req = { headers: { 'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN ?? '', 'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: session.owner_email, activeRole: session.actor_role })) } } as unknown as Request;
        const actor = await this.policy.roles.actor(req, session.project_id); await this.policy.roles.authorize(db, actor, session.project_id);
        const delivery = await this.policy.target(req, session.project_id, session.target, db);
        if (systemRoleMcpDigest(delivery.package) !== systemRoleMcpDigest(session.package) || systemRoleMcpDigest(delivery.installSet ?? null) !== systemRoleMcpDigest(session.install_set)) throw new ConflictException('Комплект MCP изменился после подтверждения.');
        if (current) {
            await this.policy.roles.current(req, current, db);
        }
    }
    /** External flags are checked before transactions; the locked authority below performs database reads only. */
    private async executionFeatures(session: McpSessionRow): Promise<void> {
        await this.features(session.target);
        if (session.run_id) {
            const row = (await this.models.pool.query<RoleRunRow>('SELECT * FROM system_role_runs WHERE id=$1 AND actor=$2 AND lease_token=$3', [session.run_id, session.owner_email, session.lease_token])).rows[0];
            if (!row) throw new ConflictException('Задача системного агента изменилась.');
            await requireFeaturesEnabled([systemRole(row.agent_id).flag, ...(row.request.sourceFeature ? [row.request.sourceFeature] : [])]);
        }
    }
    private async features(target: RoleMcpTarget): Promise<void> { await requireFeaturesEnabled(['system_role_mcp', ...(target.runtime === 'device' ? ['computer_connections' as const] : [])]); }
    private execute(session: McpSessionRow, call: McpCallRow, signal?: AbortSignal): void {
        const task = (async () => {
            try {
                const value = await this.gateway('execute', { callId: call.id }, AbortSignal.any([this.stop.signal, ...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, new Date(call.deadline_at).getTime() - Date.now()))]));
                await this.repository.finish(call.id, normalizeRoleMcpResult(value, call.kind));
            } catch { const current = await this.repository.call(call.id); if (['queued', 'dispatched'].includes(current.state)) await this.repository.finish(call.id, { state: current.state === 'dispatched' ? 'unknown' : 'failed', message: 'MCP не подтвердил результат. Автоматического повтора нет; проверьте подключение и состояние инструмента.' }); }
            finally { if (call.kind === 'list') await this.closeSession(session.id); }
        })().catch(() => undefined).finally(() => this.tasks.delete(task)); this.tasks.add(task);
    }
    private async gateway(operation: 'execute' | 'close', body: unknown, signal: AbortSignal): Promise<unknown> {
        const token = process.env.NEUROCENTER_INTERNAL_TOKEN; if (!token) throw new ConflictException('Серверный канал MCP не настроен.');
        const response = await fetch((process.env.API_GATEWAY_URL || 'http://localhost:4000').replace(/\/+$/, '') + '/internal/system-role-mcp/' + operation, { method: 'POST', headers: { 'content-type': 'application/json', 'x-neurocenter-internal': token }, body: JSON.stringify(body), redirect: 'error', signal });
        if (!response.ok) { await response.body?.cancel(); throw new ConflictException('Серверный MCP не подтвердил запрос.'); }
        const reader = response.body?.getReader(), parts: Uint8Array[] = []; let bytes = 0;
        try { if (reader) for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new ConflictException('Ответ MCP превысил лимит.'); } parts.push(part.value); } }
        finally { reader?.releaseLock(); } return JSON.parse(Buffer.concat(parts).toString('utf8'));
    }
    private async closeSession(id: string, onlyUnclaimed = false): Promise<void> {
        const session = await this.repository.close(id, onlyUnclaimed);
        if (session.state !== 'closed') return;
        this.owned.delete(id);
        if (session.target.runtime === 'server') await this.gateway('close', { sessionId: session.id, package: session.package }, AbortSignal.timeout(5000)).catch(() => undefined);
    }
    private async expire(): Promise<void> {
        const rows = (await this.models.pool.query<{ id: string }>(`SELECT s.id FROM system_role_mcp_sessions s LEFT JOIN system_role_runs r ON r.id=s.run_id WHERE s.state='open'
            AND (s.deadline_at<=now() OR s.claimed_at IS NOT NULL AND s.worker_lease_until<=now()
                OR EXISTS(SELECT 1 FROM system_role_mcp_calls c WHERE c.session_id=s.id AND c.state IN ('queued','dispatched') AND c.deadline_at<=now())
                OR s.run_id IS NOT NULL AND (r.state<>'running' OR r.lease_token<>s.lease_token OR r.lease_until<=now())) LIMIT 32`)).rows;
        await Promise.allSettled(rows.map(row => this.closeSession(row.id)));
    }
    private receipt(row: McpCallRow): RoleMcpReceipt {
        const result = row.result?.state === 'succeeded' ? row.result : row.late_result?.state === 'succeeded' ? row.late_result : undefined;
        const output = result && !('tools' in result.value) ? result.value as RoleMcpOutput : undefined;
        return { id: row.id, toolKey: row.tool_key!, name: row.name!, state: ['succeeded', 'failed', 'unknown', 'cancelled'].includes(row.state) ? row.state as RoleMcpReceipt['state'] : 'unknown',
            ...(output ? { output } : {}), message: row.state === 'succeeded' ? 'Инструмент вернул результат.' : row.late_result?.state === 'succeeded' ? 'Поздний ответ сохранён отдельно. Состояние задачи не изменено.' : row.result && 'message' in row.result ? row.result.message : 'Исход вызова не подтверждён. Автоматического повтора нет.', at: new Date(row.completed_at ?? row.created_at).toISOString() };
    }
}
