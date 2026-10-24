import {LEARNING_QUIRKS_KIND,quirksJobPayload,assertQuirksJob} from '../learning-quirks/learning-quirks-jobs';
import {MEMORY_SYNC_JOB} from '../../../shared/project-learning-memory-sync.cjs';
import {memorySyncJobPayload,assertMemorySyncJob} from '../learning-memory-sync/jobs';
import {PROJECT_CONFIGURATION_JOB} from '../../../shared/project-configuration.cjs';
import {DeviceCodexService} from '../models/device-codex.service';
import {DEVICE_CODEX_JOB} from '../../../shared/device-codex-inference.cjs';
import {projectConfigurationPayload,assertProjectConfigurationJob,authorizeProjectConfiguration} from './project-configuration-jobs';
import {PROJECT_AGENTS_JOB} from '../../../shared/project-agents.cjs';
import {compileAgentJob} from '../agents/agent-job-compiler';
import {agentConfigurationJobPayload,assertAgentConfigurationJob} from '../agents/agent-jobs';
import {projectSnapshotPayload,assertProjectSnapshotJob,SNAPSHOT_JOB_KIND} from './project-snapshot-jobs';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    Optional,
    NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { IAccessActor, projectLevel } from '../access/access.model';
import { Device, DeviceStore, digest } from './device-store';
import { DeviceArtifacts } from './device-artifacts';
import {DeviceInstallations} from './device-installations';
import {assertDeviceCatalogAsset} from './device-catalog-access';
import type { IPackage } from '../catalog/bundle-package';
import {InstallPlans} from './install-plans';
import {recordDeviceOperation,notifyDeviceOperations} from './device-operations';
import { enqueueDeviceJob } from './device-enqueue';
import {findDeviceJobRequest} from './device-job-requests';
import { assertManagedBridge, assertPackageBridge, assertInstallationSetBridge, assertInstallationInspectionBridge, assertExpectedBinding, managedBinding } from './device-compatibility';
import {assertInstallablePackage,verifyInstallationSet,type IInstallationSet} from './installation-set';
import { workspaceJobPayload, assertWorkspaceSource } from './workspace-jobs';
import { localChangeJobPayload, assertLocalFeature, assertLocalChangeAvailable } from './local-change-jobs';

import type { Job, JobInput } from './device-job.model';
export type { JobInput } from './device-job.model';
import { PROJECT_LOCAL_KINDS } from './project-local-actions';
import { projectLocalJobPayload, assertProjectLocalJob } from './project-local-jobs';
import { CONFIGURATION_KINDS } from './mcp-config-reports';
import { mcpConfigurationJobPayload, assertMcpConfigurationJob } from './mcp-config-jobs';
import { authorizeMcpConfigurationSave } from './mcp-config-permit';
import {OPENCODE_PROVIDER_JOBS} from '../../../shared/opencode-providers.cjs';
import {providerJobPayload,assertProviderJob} from './opencode-provider-jobs';
import {authorizeProviderAction} from './opencode-provider-permit';
import {reconcileSnapshotJobs} from './project-snapshot-completion';
import {RUNTIME_CACHE_POLICY_JOB} from '../../../shared/runtime-cache-policy.cjs';
import {runtimeCacheWorkRole,runtimeCacheJobPayload,assertRuntimeCacheJob,assertRuntimeCacheAuthority} from './runtime-cache-jobs';
import { transitionDeviceJobs } from './device-job-transition';
import { assertRuntimeConfigurationRevisions } from './mcp-config-status';
import { hasDeviceJobPermission,jobMinimumLevel } from './device-job-access';
import { deviceJobRetryPolicy } from './device-job-retry';
import { assertRagJobBinding, assertRagJobProtocol, RAG_JOB_KINDS, RAG_GENERATION_PROTOCOL } from './rag-job-binding';
import { isLegacyRagJob, RAG_UPGRADE_MESSAGE, RAG_UPGRADE_RESULT } from './rag-job-result';
import {ragUiJobPayload,assertRagUiJob} from './rag-ui-jobs';
import {ragInstallationJobPayload} from './rag-installation-authority';
import {requireFeaturesEnabled} from '../features/require-feature-enabled';
import {requiredJobFeatures} from '../../../shared/feature-policy.cjs';
import { ProjectEmbeddingService } from '../models/project-embedding.service';
import {registerHostedRagGrant} from './hosted-rag-grants';
import { HOSTED_RAG_KIND, hostedRagJobPayload, assertHostedRagJob } from './hosted-rag-jobs';
import {assertRagAutoInspection} from './rag-install-inspection';
const view = `id,device_id AS "deviceId",project_id AS "projectId",kind,state,percent,message,result,created_at AS "createdAt",started_at AS "startedAt",updated_at AS "updatedAt",payload->>'assetId' AS "assetId",payload->>'assetKind' AS "assetKind",payload->>'version' AS version,payload->>'bindingId' AS "bindingId",payload->'package'->'manifest'->>'sha256' AS "expectedManifest",payload->>'instanceId' AS "expectedInstanceId",
    payload->'descriptor'->>'providerKind' AS "providerKind",payload->'descriptor'->>'providerId' AS "providerId",payload->'descriptor'->>'schemaDigest' AS "providerSchemaDigest",
    payload->'descriptor'->'expectations'->>'catalogModelId' AS "catalogModelId",payload->'descriptor'->'expectations'->>'modelPin' AS "expectedModelPin"`;

/** Очередь с арендой: потеря worker не превращается в успех или повторную запись без проверки. */
@Injectable()
export class DeviceJobs {
    constructor(
        private readonly store: DeviceStore,
        private readonly artifacts: DeviceArtifacts,
        private readonly installations:DeviceInstallations,
        private readonly plans: InstallPlans,
        private readonly embedding: ProjectEmbeddingService,
        @Optional()private readonly codex?:DeviceCodexService,
    ) {}
    /** Повтор создаёт новое задание через обычные проверки, сохраняя исходную запись журнала. */
    async retry(actor:IAccessActor,id:string,requestKey:string){
        if(!/^[-a-f0-9]{36}$/.test(requestKey||'')){throw new BadRequestException('Нужен ключ запроса для повторного задания.');}
        const {rows}=await this.store.pool.query('SELECT * FROM bridge_jobs WHERE id=$1 AND email=$2',[id,actor.email]);
        const job=rows[0] as Job|undefined;
        if(!job){throw new NotFoundException('Задание не найдено в вашем профиле.');}
        if (!deviceJobRetryPolicy(job.kind).retrySupported) {
            throw new ConflictException('Откройте мастер или проверку инструмента заново: повтор требует актуальной папки и нового подтверждения.');
        }
        if(!['failed','cancelled'].includes(job.state)){throw new ConflictException('Повтор доступен только для неуспешного или отменённого задания.');}
        const pkg=job.payload.package as {manifest?:{sha256?:string}}|undefined;
        const manifest=(job.payload.installSet as {manifest?:string}|undefined)?.manifest ?? pkg?.manifest?.sha256;
        if (job.kind === 'install' && (!job.payload.planId || !pkg?.manifest?.sha256)) { throw new ConflictException('Старое задание не содержит одобренного плана. Подготовьте установку заново.'); }
        return this.create(actor,{deviceId:job.device_id,projectId:job.project_id||undefined,kind:job.kind,requestKey,assetId:job.payload.assetId as string|undefined,assetKind:job.payload.assetKind as string|undefined,version:job.payload.version as number|undefined,folderName:job.payload.folderName as string|undefined,...(['install','uninstall','inspect-installation'].includes(job.kind)?{expectedManifest:manifest,expectedBindingId:job.payload.bindingId as string|undefined}:{}),...(RAG_JOB_KINDS.includes(job.kind)?{expectedBindingId:job.payload.bindingId as string|undefined}:{}),...(job.kind==='install'?{planId:job.payload.planId as string,planRevision:job.payload.planRevision as number}:{})});
    }
    private async permission(device: Device, role: string, projectId?: string, minimum = 2) {
        const claims = await this.store.access.claims(device.email);
        if (
            !claims.userRoles.includes(role) ||
            !claims.userRoles.includes(device.role)
        ) {
            throw new ForbiddenException('Назначение роли отозвано.');
        }
        if (projectId) {
            const exists = await this.store.pool.query(
                'SELECT 1 FROM projects WHERE id=$1',
                [projectId],
            );
            if (!exists.rowCount) {
                throw new NotFoundException('Проект удалён.');
            }
            if (
                !hasDeviceJobPermission(claims,role,device.role,projectId,minimum)
            ) {
                throw new ForbiddenException(
                    minimum === 1 ? 'Проверка требует доступа к этому проекту и подключению MCP.' : minimum>=3 ? 'Настройка требует роли администратора проекта и подходящей роли подключения моста.' : 'Действие требует роли разработчика в этом проекте и в подключении MCP.',
                );
            }
        }
        return claims;
    }
    /** Plan captures one exact installation without writing a job before server selection is promoted. */
    async validateReindexTarget(actor:IAccessActor,projectId:string,target:import('../models/project-reindex.types').IReindexConnectionTarget):Promise<void>{
        const device=await this.store.owned(actor,target.deviceId);await this.permission(device,actor.activeRole,projectId,2);
        assertManagedBridge(device.report);assertLocalFeature(device.report,'hosted-rag-reindex-v1');assertLocalFeature(device.report,'hosted-rag-profile-values-v1');
        const approved=await ragInstallationJobPayload(this.installations,this.plans,device,{...target,projectId,kind:'connect-rag-model',requestKey:randomUUID()},'core');
        if((approved?.package.config?.extra?.hostedEmbedding as {reindexSchemaVersion?:unknown}|undefined)?.reindexSchemaVersion!==1)throw new ConflictException('Обновите выбранную установку OpenCodeRAG для переиндексации.');
    }
    async create(actor: IAccessActor, input: JobInput) {
        if (
            !input ||
            ![
                'choose-root',
                RUNTIME_CACHE_POLICY_JOB,
                MEMORY_SYNC_JOB,
                LEARNING_QUIRKS_KIND,
                SNAPSHOT_JOB_KIND,
                PROJECT_AGENTS_JOB,
                PROJECT_CONFIGURATION_JOB,
                ...PROJECT_LOCAL_KINDS,
                ...CONFIGURATION_KINDS,
                ...OPENCODE_PROVIDER_JOBS,
                'bind-project',
                'prepare-bind-project',
                'prepare-local-change',
                'apply-local-change',
                'open-local-change-report',
                'open-local-recovery-folder',
                'open-rag-ui',
                HOSTED_RAG_KIND,
                'probe-runtime',
                'install',
                'uninstall',
                'inspect-installation',
                'restore-rag',
                'sync-rag',
            ].includes(input.kind) ||
            !/^[-a-f0-9]{36}$/.test(input.requestKey || '')
        ) {
            throw new BadRequestException(
                'Некорректный вид задания или ключ запроса.',
            );
        }
        const device = await this.store.owned(actor, input.deviceId);
        if(input.kind===RUNTIME_CACHE_POLICY_JOB&&Object.prototype.hasOwnProperty.call(input,'projectId'))throw new BadRequestException('Лимит кэша относится к компьютеру и не принимает проект.');
        if(input.kind===RUNTIME_CACHE_POLICY_JOB&&(!runtimeCacheWorkRole(actor.activeRole)||!runtimeCacheWorkRole(device.role)))throw new ForbiddenException('Настройка компьютера требует действующей рабочей роли пользователя и моста.');
        if(input.kind==='scan-opencode-models'&&actor.activeRole!=='Главный админ')throw new ForbiddenException('Импорт конфигурации моделей доступен главному администратору.');
        await this.permission(
            device,
            actor.activeRole,
            input.kind === 'choose-root' ? undefined : input.projectId,
            jobMinimumLevel(input.kind),
        );
        if (input.kind !== 'choose-root' && input.kind!==RUNTIME_CACHE_POLICY_JOB && !(input.kind==='scan-opencode-models'&&input.scope==='global') && !input.projectId) {
            throw new BadRequestException('Выберите серверный проект.');
        }
        const requestHash = digest(
            JSON.stringify({role:actor.activeRole,request:Object.entries(input).sort(([a],[b])=>a.localeCompare(b))}),
        );
        const previous=await findDeviceJobRequest(this.store.pool,view,{email:actor.email,deviceId:input.deviceId,requestKey:input.requestKey,requestHash});
        if(previous)return previous;
        if(input.kind!==PROJECT_AGENTS_JOB)await requireFeaturesEnabled(requiredJobFeatures(input.kind,input));
        let payload: Record<string, unknown> = {};
        if (['restore-rag', 'sync-rag'].includes(input.kind) && device.report.ragSupported === false) {
            throw new ConflictException('Локальная LanceDB недоступна на выбранном компьютере. Проверьте ОС и архитектуру автономного пакета MCP.');
        }
        assertManagedBridge(device.report);
        if(input.kind===RUNTIME_CACHE_POLICY_JOB)payload={...runtimeCacheJobPayload(device,input,actor.activeRole)!};
        if (RAG_JOB_KINDS.includes(input.kind)) {
            payload = {bindingId:assertRagJobBinding(device.report,input.projectId,input.expectedBindingId),ragProtocol:RAG_GENERATION_PROTOCOL};
        }
        if (input.kind === 'open-local-recovery-folder') {
            assertLocalFeature(device.report,'local-change-plan-v1');
            const bindingId=managedBinding(device.report,input.projectId); assertExpectedBinding(bindingId,input.expectedBindingId,true);
            payload={bindingId};
        }
        const quirks=await quirksJobPayload({store:this.store,installations:this.installations,plans:this.plans},device,input);
        const memorySync=await memorySyncJobPayload({store:this.store,installations:this.installations,plans:this.plans},device,input,actor);
        const agentConfiguration=await agentConfigurationJobPayload(this.store,device,input);
        const snapshot=await projectSnapshotPayload(this.store,device,input);
        const ragUi=await ragUiJobPayload(this.installations,this.plans,device,input);
        const hostedRag=await hostedRagJobPayload(this.embedding,this.installations,this.plans,device,input);
        const configuration=await mcpConfigurationJobPayload(this.store,this.installations,this.plans,device,input);
        const projectConfiguration=await projectConfigurationPayload(this.installations,device,input);
        const provider=await providerJobPayload(this.store,this.artifacts,device,input,actor.activeRole);
        const projectLocal = await projectLocalJobPayload(this.store,this.installations,this.plans,device,input);
        if(quirks){payload=quirks;}
        else if(memorySync){payload=memorySync;}
        else if(projectConfiguration){payload=projectConfiguration;}
        else if(provider){payload=provider;}
        else if(agentConfiguration){payload={...agentConfiguration};}
        else if(snapshot){payload=snapshot;}
        else if(hostedRag){payload=hostedRag;}
        else if(ragUi){payload=ragUi;}
        else if(configuration){payload=configuration;}
        else if (projectLocal) { payload=projectLocal; }
        else if (['prepare-local-change','apply-local-change','open-local-change-report','probe-runtime'].includes(input.kind)) {
            payload = await localChangeJobPayload(this.store,this.installations,this.plans,device,input);
        }
        if (['bind-project','prepare-bind-project'].includes(input.kind)) {
            if (
                typeof input.folderName !== 'string' ||
                !input.folderName ||
                input.folderName.length > 255 ||
                /[/\\\x00]/.test(input.folderName) ||
                ['.', '..'].includes(input.folderName)
            ) {
                throw new BadRequestException('Выберите папку из списка MCP.');
            }
            payload = await workspaceJobPayload(this.store, this.installations, device, input);
        }
        if (input.kind === 'install') {
            assertInstallationSetBridge(device.report);
            const bindingId = managedBinding(device.report, input.projectId);
            assertExpectedBinding(bindingId,input.expectedBindingId);
            await this.assertCatalogAsset(input.projectId, input.assetKind, input.assetId);
            const {package:pkg,installSet} = await this.plans.delivery(input.planId, input.projectId!, input.assetKind, input.assetId, input.version, input.planRevision, input.expectedManifest);
            assertPackageBridge(device.report, pkg);
            payload = {
                assetId: input.assetId,
                assetKind: input.assetKind,
                version: input.version,
                package: pkg,
                bindingId,
                planId: input.planId,
                planRevision: input.planRevision,
                ...(installSet ? {installSet} : {}),
            };
        }
        if(input.kind==='uninstall'){
            assertInstallationSetBridge(device.report);
            const bindingId = managedBinding(device.report, input.projectId);
            assertExpectedBinding(bindingId,input.expectedBindingId,true);
            const pkg=await this.installations.removalPackage(actor,{...input,bindingId});
            assertPackageBridge(device.report, pkg);
            payload={assetId:pkg.plugin.id,assetKind:pkg.plugin.kind,version:pkg.plugin.version,package:pkg,bindingId};
        }
        if(input.kind==='inspect-installation'){
            const bindingId = managedBinding(device.report,input.projectId);
            assertExpectedBinding(bindingId,input.expectedBindingId,true);
            assertInstallationInspectionBridge(device.report);
            const pkg = await this.installations.inspectionPackage(actor,{...input,bindingId});
            assertPackageBridge(device.report,pkg);
            payload={assetId:pkg.plugin.id,assetKind:pkg.plugin.kind,version:pkg.plugin.version,package:pkg,bindingId};
        }
        if(input.kind===PROJECT_AGENTS_JOB)await requireFeaturesEnabled(requiredJobFeatures(input.kind,payload,true));
        return enqueueDeviceJob(this.store.pool, view, {
            id: randomUUID(), deviceId: device.id, email: actor.email, role: actor.activeRole,
            projectId: input.projectId, kind: input.kind, payload,
            requestKey: input.requestKey, requestHash,
        },async()=>{await requireFeaturesEnabled(requiredJobFeatures(input.kind,payload,true));return this.store.access.claims(actor.email);});
    }
    /** История и отмена используют свежие назначения; владение компьютером не заменяет доступ к проекту. */
    private async readScope(actor: IAccessActor) {
        const claims = await this.store.access.claims(actor.email);
        if (!claims.userRoles.includes(actor.activeRole)) { throw new ForbiddenException('Назначение активной роли отозвано.'); }
        return { email: claims.email, main: actor.activeRole === 'Главный админ',
            projects: claims.projects.filter(project => projectLevel(claims, actor.activeRole, project.projectId) > 0).map(project => project.projectId) };
    }
    async list(actor: IAccessActor) {
        const scope = await this.readScope(actor);
        await this.expire();
        const access = "AND ($2::boolean OR project_id=ANY($3::text[]) OR (project_id IS NULL AND kind IN ('choose-root','runtime-cache-policy')))";
        return (
            await this.store.pool.query(
                `SELECT ${view} FROM bridge_jobs WHERE email=$1 ${access} AND (state IN ('queued','running','reconciling')
                OR id IN (SELECT id FROM bridge_jobs WHERE email=$1 ${access} AND state NOT IN ('queued','running','reconciling') ORDER BY created_at DESC LIMIT 100))
                ORDER BY created_at DESC`,
                [scope.email,scope.main,scope.projects],
            )
        ).rows;
    }
    private async expire() {
        await reconcileSnapshotJobs(this.store.pool);
        await transitionDeviceJobs(this.store.pool,
            "UPDATE bridge_jobs SET state='reconciling',message='Мост потерял соединение. Ожидаем сверку сохранённого локального результата.',updated_at=now() WHERE state='running' AND lease_until<now() RETURNING *",
            [],{state:'RUNNING',message:'Ожидает сверки после потери соединения моста.'},
        );
        await transitionDeviceJobs(this.store.pool,
            "UPDATE bridge_jobs SET state='cancelled',message='Задание ожидало моста больше суток и отменено. Повторите действие, если оно ещё нужно.',updated_at=now() WHERE state='queued' AND created_at<now()-interval '24 hours' RETURNING *",
            [],{state:'CANCELLED',percent:0,message:'Срок ожидания моста истёк.'});
    }
    async claim(device: Device) {
        await this.expire();
        const client = await this.store.pool.connect();
        let job: Job | undefined;
        let discard = false;
        try {
            await client.query('BEGIN');
            const connection = await client.query('SELECT id,paused_until>now() AS paused FROM bridge_devices WHERE id=$1 FOR UPDATE', [device.id]);
            if (connection.rows[0]?.paused) { await client.query('COMMIT'); return null; }
            const active = await client.query("SELECT 1 FROM bridge_jobs WHERE device_id=$1 AND state='running' AND lease_until>now() LIMIT 1", [device.id]);
            if (active.rows.length) { await client.query('COMMIT'); return null; }
            const { rows } = await client.query(
                "SELECT * FROM bridge_jobs WHERE device_id=$1 AND state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
                [device.id],
            );
            job = rows[0] as Job | undefined;
            if (job) {
                job.lease = randomUUID();
                await client.query(
                    "UPDATE bridge_jobs SET state='running',lease=$2,lease_until=now()+interval '3 minutes',started_at=now(),percent=0,message='Мост принял задание',updated_at=now() WHERE id=$1",
                    [job.id, job.lease],
                );
                await recordDeviceOperation(client,job,'RUNNING',0,'Мост принял задание');
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => { discard = true; });
            throw error;
        } finally {
            client.release(discard);
        }
        if (!job) {
            return null;
        }
        try {
            assertManagedBridge(device.report);
            if (RAG_JOB_KINDS.includes(job.kind)) { assertRagJobProtocol(job.payload);assertRagJobBinding(device.report,job.project_id || undefined,job.payload.bindingId); }
            if(job.kind===SNAPSHOT_JOB_KIND)await assertProjectSnapshotJob(this.store,device,job);
        await assertProjectLocalJob(this.store,this.installations,this.plans,device,job);
            await assertMcpConfigurationJob(this.store,this.installations,this.plans,device,job);
            await assertProviderJob(this.store,this.artifacts,device,job);
            if(job.kind===DEVICE_CODEX_JOB&&!this.codex)throw new ConflictException('Подключение Codex недоступно.');
            await this.codex?.authorizeJob(device,job);
            assertRuntimeCacheJob(device,job);
            await assertAgentConfigurationJob(this.store,device,job);
        await assertMemorySyncJob({store:this.store,installations:this.installations,plans:this.plans},device,job);
        await assertQuirksJob({store:this.store,installations:this.installations,plans:this.plans},device,job);
            await assertProjectConfigurationJob(this.installations,device,job);
            await assertRagUiJob(this.installations,this.plans,device,job);
            await assertHostedRagJob(this.embedding,this.installations,this.plans,device,job);
            if (job.kind === 'open-local-recovery-folder') { assertLocalFeature(device.report,'local-change-plan-v1'); }
            if (!job.payload.localPlanPurpose && ['prepare-local-change','apply-local-change','open-local-change-report','probe-runtime'].includes(job.kind)) {
                assertLocalFeature(device.report,job.kind === 'probe-runtime' ? 'runtime-probe-v1' : 'local-change-plan-v1');
                await this.assertJobPlan(job);
                if(job.kind==='probe-runtime')await assertRuntimeConfigurationRevisions(this.store.pool,device.email,device.id,job.project_id!,job.payload);
                await assertLocalChangeAvailable(this.store.pool,job);
            }
            if (['bind-project','prepare-bind-project'].includes(job.kind)) {
                assertWorkspaceSource(device.report,job.project_id!,String(job.payload.mode),job.payload.expectedBindingId as string|undefined,job.payload.expectedInstanceId as string|undefined);
            }
            if (job.payload.package) { assertPackageBridge(device.report, job.payload.package as {schemaVersion?: number}); }
            if (['install','uninstall'].includes(job.kind)) { assertInstallationSetBridge(device.report); }
            if (job.kind === 'inspect-installation') { assertInstallationInspectionBridge(device.report); }
            await this.permission(
                device,
                job.role,
                job.project_id || undefined,
                jobMinimumLevel(job.kind),
            );
            await requireFeaturesEnabled(requiredJobFeatures(job.kind,job.payload,true));
            await assertRagAutoInspection(this.store.pool,device,job);
            if(job.kind===RUNTIME_CACHE_POLICY_JOB)await this.permission(device,job.role,undefined);
            await assertRuntimeCacheAuthority(this.store.pool,device,job);
            if (job.kind === 'install') {
                await this.assertCatalogAsset(job.project_id, job.payload.assetKind, job.payload.assetId);
                await this.assertJobPlan(job);
            }
        } catch (error) {
            // Отказ до выдачи задания — серверное решение, локальная запись ещё не началась.
            const legacyRag = isLegacyRagJob(job);
            const response=error instanceof ForbiddenException?error.getResponse():null;
            const disabled=response&&typeof response==='object'&&'code' in response&&response.code==='feature-disabled'&&'message' in response&&typeof response.message==='string'?response.message:null;
            const message = disabled ?? (legacyRag ? RAG_UPGRADE_MESSAGE : job.kind === 'inspect-installation' ? 'Проверка файлов недоступна: доступ или версия MCP изменились.'
                : 'Действие недоступно: доступ, привязка, одобрение или версия MCP изменились.');
            await transitionDeviceJobs(this.store.pool,`UPDATE bridge_jobs SET state='failed',message=$4,result=${legacyRag?'$5':'NULL'},updated_at=now()
                WHERE id=$1 AND device_id=$2 AND lease=$3 AND state='running' AND lease_until>now() RETURNING *`,
            [job.id,device.id,job.lease,message,...(legacyRag?[RAG_UPGRADE_RESULT]:[])],{state:'FAILED',message});
            return null;
        }
        await notifyDeviceOperations();
        return { ...job, state: 'running' };
    }
    async authorize(device: Device, id: string, lease: string,options?:{snapshotReceipt?:boolean}) {
        const { rows } = await this.store.pool.query(
            "SELECT * FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND lease=$3 AND state='running' AND lease_until>now()",
            [id, device.id, lease],
        );
        const job = rows[0] as Job | undefined;
        if (!job) {
            throw new ConflictException(
                'Задание завершено, отменено или аренда истекла.',
            );
        }
        await this.permission(device, job.role, job.project_id || undefined,jobMinimumLevel(job.kind));
        if(job.kind===DEVICE_CODEX_JOB&&!this.codex)throw new ConflictException('Подключение Codex недоступно.');
        await this.codex?.authorizeJob(device,job);
        assertRuntimeCacheJob(device,job);
        if(options?.snapshotReceipt&&job.kind!==SNAPSHOT_JOB_KIND)throw new BadRequestException('Подтверждение снимка не относится к этому заданию.');
        if(!options?.snapshotReceipt)await requireFeaturesEnabled(requiredJobFeatures(job.kind,job.payload,true));
        await assertRagAutoInspection(this.store.pool,device,job);
        if (RAG_JOB_KINDS.includes(job.kind)) { assertRagJobProtocol(job.payload);assertRagJobBinding(device.report,job.project_id || undefined,job.payload.bindingId); }
        if(job.kind===SNAPSHOT_JOB_KIND)await assertProjectSnapshotJob(this.store,device,job);
        await assertProjectLocalJob(this.store,this.installations,this.plans,device,job);
        await assertMcpConfigurationJob(this.store,this.installations,this.plans,device,job);
        await assertAgentConfigurationJob(this.store,device,job);
        await assertMemorySyncJob({store:this.store,installations:this.installations,plans:this.plans},device,job);
        await assertQuirksJob({store:this.store,installations:this.installations,plans:this.plans},device,job);
        await assertProjectConfigurationJob(this.installations,device,job);
        await assertRagUiJob(this.installations,this.plans,device,job);
        await assertHostedRagJob(this.embedding,this.installations,this.plans,device,job);
        if (job.kind === 'open-local-recovery-folder') { assertLocalFeature(device.report,'local-change-plan-v1'); }
        if (!job.payload.localPlanPurpose && ['prepare-local-change','apply-local-change','open-local-change-report','probe-runtime'].includes(job.kind)) {
            assertLocalFeature(device.report,job.kind === 'probe-runtime' ? 'runtime-probe-v1' : 'local-change-plan-v1');
            await this.assertJobPlan(job);
            if(job.kind==='probe-runtime')await assertRuntimeConfigurationRevisions(this.store.pool,device.email,device.id,job.project_id!,job.payload);
            await assertLocalChangeAvailable(this.store.pool,job);
        }
        if (['bind-project','prepare-bind-project'].includes(job.kind)) {
            assertWorkspaceSource(device.report,job.project_id!,String(job.payload.mode),job.payload.expectedBindingId as string|undefined,job.payload.expectedInstanceId as string|undefined);
        }
        if (job.kind === 'inspect-installation') { assertInstallationInspectionBridge(device.report); }
        if (['install','uninstall'].includes(job.kind)) { assertInstallationSetBridge(device.report); }
        if (job.kind === 'install') {
            await this.assertCatalogAsset(job.project_id, job.payload.assetKind, job.payload.assetId);
            await this.assertJobPlan(job);
        }
        if (!(job.kind==='scan-opencode-models'&&job.payload.scope==='global'&&job.project_id===null) && [...CONFIGURATION_KINDS,...PROJECT_LOCAL_KINDS,'install', 'uninstall','inspect-installation','prepare-local-change','apply-local-change','open-local-change-report','open-local-recovery-folder','probe-runtime'].includes(job.kind) && job.payload.bindingId !== managedBinding(device.report, job.project_id || undefined)) {
            throw new ConflictException('Привязка папки изменилась после отправки задания. Повторите действие для актуальной папки.');
        }
        await registerHostedRagGrant(this.store.pool,device,job,lease,()=>assertHostedRagJob(this.embedding,this.installations,this.plans,device,job));
        if(OPENCODE_PROVIDER_JOBS.includes(job.kind as never)){
            await assertProviderJob(this.store,this.artifacts,device,job);
            await this.permission(device,job.role,job.project_id??undefined,2);
            const current=await this.store.pool.query(`SELECT job.id FROM bridge_jobs job JOIN bridge_devices device ON device.id=job.device_id
                WHERE job.id=$1 AND job.device_id=$2 AND job.email=$3 AND job.role=$4 AND job.lease=$5
                AND job.state='running' AND job.lease_until>clock_timestamp() AND job.payload->'descriptor'=$6::jsonb
                AND device.email=$3 AND device.role=$7 AND NOT device.revoked AND device.expires_at>clock_timestamp()
                AND EXISTS(SELECT 1 FROM jsonb_array_elements(device.report->'bindings') binding WHERE binding->>'projectId'=job.project_id
                    AND binding->>'bindingId'=job.payload->>'bindingId' AND binding->>'instanceId'=job.payload->>'instanceId' AND binding->>'valid' IS DISTINCT FROM 'false')`,
            [job.id,device.id,device.email,job.role,lease,JSON.stringify(job.payload.descriptor),device.role]);
            if(!current.rows.length)throw new ConflictException('Задание или привязка провайдера изменились во время проверки.');
            await requireFeaturesEnabled(requiredJobFeatures(job.kind,job.payload,true));
        }
        if(job.kind===RUNTIME_CACHE_POLICY_JOB)await this.permission(device,job.role,undefined);
        await assertRuntimeCacheAuthority(this.store.pool,device,job);
        return { ok: true, projectId: job.project_id, role: job.role,...(job.kind===SNAPSHOT_JOB_KIND?{snapshotId:job.payload.snapshotId,snapshotProtocol:job.payload.snapshotProtocol}: {}) };
    }
    async memorySyncContext(device:Device,input:unknown){
        const value=input as {jobId?:unknown;lease?:unknown}|null;
        if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='jobId,lease'||typeof value.jobId!=='string'||typeof value.lease!=='string')throw new BadRequestException('Нужны точное задание Memory и аренда.');
        await this.authorize(device,value.jobId,value.lease);
        const job=(await this.store.pool.query<Job>("SELECT * FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND email=$3 AND lease=$4 AND kind=$5 AND state='running' AND lease_until>now()",[value.jobId,device.id,device.email,value.lease,MEMORY_SYNC_JOB])).rows[0];
        if(!job)throw new ConflictException('Задание Memory завершено или принадлежит другому подключению.');
        return assertMemorySyncJob({store:this.store,installations:this.installations,plans:this.plans},device,job);
    }
    async compileAgents(device:Device,input:unknown){return compileAgentJob(this.store,device,input,(id,lease)=>this.authorize(device,id,lease));}
    async authorizeConfiguration(device:Device,input:unknown){
        return authorizeMcpConfigurationSave(this.store,this.installations,this.plans,device,input,
            async(role,projectId)=>{await this.permission(device,role,projectId,2);await requireFeaturesEnabled(requiredJobFeatures('open-mcp-configuration'));});
    }
    async authorizeProvider(device:Device,input:unknown){
        return authorizeProviderAction(this.store,this.artifacts,device,input,(role,projectId)=>this.permission(device,role,projectId,2));
    }
    async authorizeProjectConfiguration(device:Device,input:unknown){
        return authorizeProjectConfiguration(this.store,this.installations,device,input,(role,projectId)=>this.permission(device,role,projectId,3));
    }
    /** Общие инструменты требуют выбора админа; собственные проектные скиллы доступны по роли. */
    private async assertCatalogAsset(projectId: unknown, kind: unknown, id: unknown): Promise<void> {
        await assertDeviceCatalogAsset(this.store.pool,projectId,kind,id);
    }
    private async assertJobPlan(job: Job): Promise<void> {
        const pkg = job.payload.package as {manifest?: {sha256?: string}} | undefined;
        if (!pkg?.manifest?.sha256) { throw new ConflictException('В задании нет закреплённого пакета. Подготовьте установку заново.'); }
        const set=job.payload.installSet as IInstallationSet|undefined;
        if(set && !verifyInstallationSet(set)){throw new ConflictException('Состав набора повреждён. Подготовьте установку заново.');}
        assertInstallablePackage(pkg as IPackage);
        const approved=await this.plans.package(job.payload.planId, job.project_id!, job.payload.assetKind, job.payload.assetId, job.payload.version, job.payload.planRevision, set?.manifest ?? pkg.manifest.sha256);
        if(approved.manifest.sha256!==pkg.manifest.sha256)throw new ConflictException('Job package differs from the approved immutable package.');
    }
    async update(
        device: Device,
        id: string,
        input: {
            lease: string;
            state?: string;
            percent?: number;
            message?: string;
            result?: unknown;
        },
    ) {
        if (input && ['succeeded', 'failed'].includes(input.state ?? '')) {
            throw new BadRequestException('Завершайте задание через подтверждение результата, а не обновление прогресса.');
        }
        if (
            !input ||
            !['running'].includes(
                input.state || 'running',
            ) ||
            (input.percent !== undefined &&
                (!Number.isInteger(input.percent) ||
                    input.percent < 0 ||
                    input.percent > 100)) ||
            typeof input.message !== 'string' ||
            input.message.length > 1500 ||
            Buffer.byteLength(JSON.stringify(input.result ?? null)) > 512 * 1024
        ) {
            throw new BadRequestException('Некорректный статус задания.');
        }
        const selected = await this.store.pool.query<{kind:string}>(
            'SELECT kind FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND lease=$3',[id,device.id,input.lease],
        );
        if(selected.rows[0]?.kind===DEVICE_CODEX_JOB&&(input.result!==undefined&&input.result!==null&&JSON.stringify(input.result)!=='{}'))throw new BadRequestException('Приватный результат Codex передаётся только в завершении задания.');
        if (Buffer.byteLength(JSON.stringify(input.result ?? null)) > 10000) { throw new BadRequestException('Промежуточный результат превышает допустимый размер.'); }
        let progressMessage = selected.rows[0]?.kind===DEVICE_CODEX_JOB?'Codex обрабатывает запрос на компьютере.':input.message;
        if ([PROJECT_CONFIGURATION_JOB,...CONFIGURATION_KINDS,...PROJECT_LOCAL_KINDS,'bind-project','prepare-bind-project','prepare-local-change','apply-local-change','open-local-change-report','open-local-recovery-folder','probe-runtime','open-rag-ui',HOSTED_RAG_KIND].includes(selected.rows[0]?.kind)) {
            if (input.result !== undefined && input.result !== null) { throw new BadRequestException('Результат привязки передаётся только после завершения.'); }
            progressMessage = 'Мост выполняет проверенное действие.';
        }
        if (selected.rows[0]?.kind === 'inspect-installation') {
            if (input.result !== undefined && input.result !== null) {
                throw new BadRequestException('Промежуточная сверка не передаёт результат до завершения.');
            }
            progressMessage = 'Проверка файлов выполняется.';
        }
        const { rowCount } = await transitionDeviceJobs(this.store.pool,
            `UPDATE bridge_jobs SET state=$4,percent=GREATEST(COALESCE(percent,0),COALESCE($5,0)),message=$6,result=$7,lease_until=now()+interval '3 minutes',updated_at=now()
            WHERE id=$1 AND device_id=$2 AND lease=$3 AND state='running' AND lease_until>now() RETURNING *`,
            [
                id,
                device.id,
                input.lease,
                input.state || 'running',
                input.percent ?? null,
                progressMessage,
                input.result ?? null,
            ],
            {state:(input.state||'running').toUpperCase(),message:progressMessage},
        );
        if (!rowCount) {
            throw new ConflictException('Статус задания уже изменён.');
        }
        return { ok: true };
    }
    async cancel(actor: IAccessActor, id: string) {
        const scope = await this.readScope(actor);
        const access = "AND ($3::boolean OR project_id=ANY($4::text[]) OR (project_id IS NULL AND kind IN ('choose-root','runtime-cache-policy')))";
        const params = [id,scope.email,scope.main,scope.projects];
        const codex=(await this.store.pool.query<{kind:string;state:string}>(`SELECT kind,state FROM bridge_jobs WHERE id=$1 AND email=$2 ${access}`,params)).rows[0];
        if(codex?.kind===DEVICE_CODEX_JOB){
            if(['succeeded','failed'].includes(codex.state))throw new ConflictException('Запрос Codex уже завершён.');
            if(!this.codex)throw new ConflictException('Подключение Codex недоступно.');
            const outcome=await this.codex.cancel(id);
            if(!outcome.cancelled)throw new ConflictException('Запрос Codex уже завершён. Обновите журнал.');
            return {ok:true};
        }
        // Learning jobs journal each boundary and can stop between steps; filesystem jobs keep their rollback contract.
        const { rowCount } = await transitionDeviceJobs(this.store.pool,
            `UPDATE bridge_jobs SET state='cancelled',message='Отменено пользователем',updated_at=now() WHERE id=$1 AND email=$2 ${access} AND (state='queued' OR kind IN ('sync-learning-memory','import-learning-quirks') AND state IN ('running','reconciling')) RETURNING *`,
            params,
            {state:'CANCELLED',percent:0,message:'Отменено пользователем'},
        );
        if (!rowCount) {
            const {rows} = await this.store.pool.query<{state:string}>(`SELECT state FROM bridge_jobs WHERE id=$1 AND email=$2 ${access}`,params);
            if (!rows[0]) { throw new NotFoundException('Задание не найдено в доступных вам проектах.'); }
            if (rows[0].state === 'cancelled') { return {ok:true}; }
            throw new ConflictException(
                'MCP уже принял задание или оно завершено.',
            );
        }
        return { ok: true };
    }
}
