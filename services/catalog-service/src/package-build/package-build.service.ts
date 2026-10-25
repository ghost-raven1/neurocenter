import {pinBuildRecipe} from './package-agent.inventory';
import {traceToolBuild} from '../../../shared/dev-trace.cjs';
import {requireFeaturesEnabled} from '../features/require-feature-enabled';
import {requiredAssetFeatures} from '../../../shared/feature-policy.cjs';
import {buildFeatures,assertCodexBuildKind,assertCodexBuildPublication,publishedCodexConnectors} from './codex-connector-build';
import {CODEX_PLUGIN_SOURCE,isPreparedCodexRepository} from '../../../shared/codex-connector-source.cjs';
import {verifyPackage} from '../catalog/bundle-package';
import {normalizeRuntimeArtifacts} from '../../../shared/runtime-artifacts.cjs';
import {SourceUploadService} from '../source-upload/source-upload.service';
import { inspectGithubReleaseAsset, inspectGithubRepository } from '../../../shared/release-inspection.cjs';
import { ConflictException, ForbiddenException, Injectable, Optional, OnModuleDestroy, OnModuleInit, ServiceUnavailableException, BadRequestException, Logger } from '@nestjs/common';
import { createRequire } from 'node:module';
import type {ToolAsset,SkillAsset} from '@neurocenter/asset-contract';
import {validateAsset} from '@neurocenter/asset-contract';
import {AssetSourcesService} from '../asset-sources/asset-sources.service';
import {authorizeImportActor} from '../asset-sources/import-worker';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { PoolClient } from 'pg';
import { AccessDb } from '../access/access-db';
import type { IAccessActor } from '../access/access.model';
import { createPool } from '../database/pool';
import { notifyDeviceOperations } from '../devices/device-operations';
import {assertBuildCreateName,lockBuildPublication,pinBuildPublication,publicationTargetPreview} from './publication-target';
import {publishBuiltTool} from './publish-built-tool';
import {configureBuildPublicationTransaction,publicationDeadlineMessage} from './publication-deadline';
import {withBuildSqlErrors} from './build-sql-errors';
import {importBuiltSkill} from './import-skill-publication';
import type { IAiPluginCreate } from '../catalog/dto';
import { CatalogService } from '../catalog/catalog.service';
import { RuntimeArtifacts, runtimeArtifactDirectory } from '../runtime-artifacts/runtime-artifacts';
import { reserveCapacity } from '../../../shared/capacity.cjs';
import { resolveRepositorySource, validateRepositorySource, type RepositoryInput } from '../../../shared/repository-source.cjs';
import { runtimeSourceTargets } from '../../../shared/tool-runtime-source.cjs';
import { RAG_PLUGIN_SOURCE, isPreparedRagRepository } from '../../../shared/opencode-rag-source.cjs';
import { builderScript, BuildDiagnosticError, BuildProcessUnreapedError, runPackageBuilder, stagingLimit, stopBuildProcess } from './build-process';
import { resolveNpmSource } from './npm-source';
import { readSourceArchive } from './source-archive';
import { PackageBuildRepository } from './package-build.repository';
import { buildView, requestHash, validId, validateBuildInput, type BuildConfiguration, type BuildRow } from './package-build.model';
import {createToolSupply,toolSupplyPlan} from './supply-export';
import {inspectSkillSource} from './skill-source';
import {buildSkillAsset} from './build-skill';
import {BuildCancellation,BuildCancelledError,cleanupBuildStages} from './build-cancellation';
import {acknowledgeBuildCleanup,forgetBuildCleanup} from './build-cleanup';
import {PackageAgentService} from './package-agent.service';
import {buildVerifiedAttempts} from './build-attempts';
import {assertRuntimeCandidate,verifyBuildRuntime} from './build-runtime';
import {isSourceEntrypoint} from '../../../shared/source-entrypoint.cjs';
import {withToolImportDeadline} from './tool-import-deadline';
import {importToolAsset} from './import-tool-asset';

interface PreparedTool {asset:ToolAsset;publication: IAiPluginCreate; artifacts: Array<{archivePath: string; descriptor: unknown}>;sourceSnapshotPath?:string}

/** Один владелец исполняет очередь последовательно; после рестарта продолжаются ещё не начатые задания. */
@Injectable()
export class PackageBuildService implements OnModuleInit, OnModuleDestroy {
    private readonly pool = createPool({connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog', max: 3}, 'package-build');
    private readonly repository = new PackageBuildRepository(this.pool,client=>this.discardLease(client));
    private readonly logger = new Logger('PackageBuildService');
    private lease?: PoolClient;
    private releaseLease?: (destroy?: boolean) => void;
    private recovering?: Promise<void>;
    private retryTimer?: ReturnType<typeof setTimeout>;
    private retryDelay = 1000;
    private leaseUse: Promise<void> = Promise.resolve();
    private worker?: Promise<void>;
    private queueRequested = false;
    private child?: ChildProcess;
    private activeBuild?:{id:string;cancellation:BuildCancellation};
    private readonly stoppedWorkers=new Set<string>();
    private stopping = false;

    constructor(private readonly access: AccessDb, private readonly artifacts: RuntimeArtifacts, private readonly catalog: CatalogService,private readonly sources:AssetSourcesService,@Optional() private readonly uploads?:SourceUploadService,@Optional() private readonly agent?:PackageAgentService) {}

    async onModuleInit(): Promise<void> {
        await this.catalog.ensureSchema();
        await this.recoverOwnership();
    }

    /** Standby не прерывает живого владельца; повтор ограничен backoff до 15 секунд. */
    private scheduleOwnershipRetry(): void {
        if (this.stopping || this.lease || this.recovering || this.retryTimer) {return;}
        const delay = this.retryDelay;
        this.retryDelay = Math.min(delay * 2, 15000);
        this.retryTimer = setTimeout(() => {this.retryTimer = undefined; void this.recoverOwnership();}, delay);
        this.retryTimer.unref();
    }

    private recoverOwnership(): Promise<void> {
        if (this.stopping || this.lease) {return Promise.resolve();}
        if (this.recovering) {return this.recovering;}
        const pending = this.acquireOwnership().catch(() => {
            this.logger.warn('Владелец сборщика временно недоступен; повторим подключение PostgreSQL.');
        }).finally(() => {
            if (this.recovering === pending) {this.recovering = undefined;}
            this.scheduleOwnershipRetry();
        });
        this.recovering = pending;
        return pending;
    }

    private async acquireOwnership(): Promise<void> {
        await this.leaseUse;
        await this.worker?.catch(() => undefined);
        if (this.stopping || this.lease) {return;}
        const lease = await this.pool.connect();
        let released = false, owned = false;
        const release = (destroy = false): void => {
            if (released) {return;}
            released = true; lease.removeListener?.('error', lost); lease.release(destroy);
        };
        const lost = (): void => {
            const current = this.lease === lease;
            if (current) {this.lease = undefined; this.releaseLease = undefined;}
            release(true);
            if (current && this.child) {stopBuildProcess(this.child);}
            if(current)this.activeBuild?.cancellation.stop(new Error('Сборщик потерял подключение к очереди.'));
            this.retryDelay = 1000; this.scheduleOwnershipRetry();
        };
        lease.on('error', lost);
        try {
            if (this.stopping) {return;}
            owned = (await lease.query<{locked: boolean}>('SELECT pg_try_advisory_lock(72465395) AS locked')).rows[0]?.locked === true;
            if (!owned || this.stopping || released) {return;}
            await this.repository.failInterrupted(lease);
            await this.cleanupStages();
            const root = await this.stagingRoot();
            if (this.stopping || released) {return;}
            this.lease = lease; this.releaseLease = release; this.retryDelay = 1000;
            this.startWorker(root);
        } finally {
            if (this.lease !== lease) {
                if (owned && !released) {await lease.query('SELECT pg_advisory_unlock(72465395)').catch(() => undefined);}
                release();
            }
        }
    }

    async onModuleDestroy(): Promise<void> {
        this.stopping = true;
        this.activeBuild?.cancellation.stop(new Error('Сборщик останавливается. Повторите сборку новым запросом.'));
        if (this.retryTimer) {clearTimeout(this.retryTimer); this.retryTimer = undefined;}
        if (this.child) { stopBuildProcess(this.child); }
        await this.recovering?.catch(() => undefined);
        await this.leaseUse;
        await this.worker?.catch(() => undefined);
        const lease = this.lease, release = this.releaseLease;
        this.lease = undefined; this.releaseLease = undefined;
        if (lease) {await lease.query('SELECT pg_advisory_unlock(72465395)').catch(() => undefined); release?.();}
        await this.pool.end();
    }

    private currentLease(expected = this.lease): PoolClient {
        if (!expected || this.lease !== expected || this.stopping) {throw new ServiceUnavailableException('Сборщик восстанавливает подключение. Повторите запрос позже.');}
        return expected;
    }
    private discardLease(client:PoolClient):void{
        if(this.lease!==client){client.release(true);return;}
        const release=this.releaseLease;this.lease=undefined;this.releaseLease=undefined;
        release?.(true);this.activeBuild?.cancellation.stop(new Error('Сборщик потерял владельца очереди.'));if(this.child)stopBuildProcess(this.child);this.scheduleOwnershipRetry();
    }

    /** На lease-сессии не пересекаются BEGIN приёма и публикации; gate включает передачу worker. */
    private withLease<T>(expected: PoolClient, work: () => Promise<T>): Promise<T> {
        const pending = this.leaseUse.then(async () => {
            this.currentLease(expected);
            return work();
        });
        this.leaseUse = pending.then(() => undefined, () => undefined);
        return pending;
    }

    async requireMain(actor: IAccessActor): Promise<void> {
        const claims = await this.access.claims(actor?.email);
        if (actor?.activeRole !== 'Главный админ' || !claims.userRoles.includes('Главный админ')) { throw new ForbiddenException('Собирать и публиковать инструменты может главный администратор.'); }
    }

    async npm(actor: IAccessActor, specifier: unknown, entrypoint?: string) {
        await this.requireMain(actor); await requireFeaturesEnabled(['tool_builds']);
        return resolveNpmSource(specifier, entrypoint);
    }
    /** Main-admin read-only supply status avoids rebuilding an already published fixed connector. */
    async codexConnector(actor:IAccessActor):Promise<{state:'ready'|'missing'|'building'|'conflict';buildId?:string;targets?:string[]}>{
        await this.requireMain(actor);
        const pin=require('../../../shared/codex-connector-pin.json') as {sourceCommit:string;version:string;sdkVersion:string;repository:string};
        const rows=await publishedCodexConnectors(this.pool,pin);
        let result:{state:'ready'|'missing'|'building'|'conflict';buildId?:string;targets?:string[]};
        if(rows.length>1)result={state:'conflict'};
        else if(rows.length===1){
            const pkg=await this.catalog.getAiPluginPackage(rows[0].id,Number(rows[0].version));
            try{
                assertCodexBuildPublication({kind:'plugin',source:{type:'repository',...CODEX_PLUGIN_SOURCE}},
                    {name:pkg.plugin.name,kind:'plugin',description:'',config:pkg.config});
                if(!verifyPackage(pkg)||pkg.plugin.kind!=='plugin')throw new ConflictException();
                result={state:'ready',targets:normalizeRuntimeArtifacts(pkg.config?.extra?.runtimeArtifacts).map(item=>item.target)};
            }catch{result={state:'conflict'};}
        }else{
            const pending=await this.pool.query<{id:string;targets:string[]}>(`SELECT id,config->'targets' AS targets FROM tool_build_jobs WHERE state IN ('QUEUED','RUNNING')
                AND config->>'kind'='plugin' AND config#>>'{source,type}'='repository' AND config#>>'{source,url}'=$1
                AND config#>>'{source,commit}'=$2 AND config#>>'{source,subdirectory}'=$3 AND config#>>'{source,entrypoint}'=$4 ORDER BY created_at,id`,
            [CODEX_PLUGIN_SOURCE.url,CODEX_PLUGIN_SOURCE.commit,CODEX_PLUGIN_SOURCE.subdirectory,CODEX_PLUGIN_SOURCE.entrypoint]);
            result=pending.rows.length>1?{state:'conflict'}:pending.rows.length?{state:'building',buildId:pending.rows[0].id,targets:pending.rows[0].targets}:{state:'missing'};
        }
        await this.requireMain(actor);return result;
    }
    async archiveSource(actor: IAccessActor, input: unknown) {
        await this.requireMain(actor); await requireFeaturesEnabled(['tool_builds']);
        return readSourceArchive(input);
    }
    async repositorySource(actor: IAccessActor, input: Omit<RepositoryInput, 'type'>) {
        await this.requireMain(actor); await requireFeaturesEnabled(['tool_builds']);
        try {return await resolveRepositorySource(input, {inspectAsset: inspectGithubReleaseAsset, inspectRepository: inspectGithubRepository,inspectSkill:files=>inspectSkillSource(files,{metadataOnly:true})});}
        catch (error) {throw new BadRequestException(error instanceof Error ? error.message : 'Не удалось проверить репозиторий GitHub.');}
    }

    async get(actor: IAccessActor, id: string) {
        await this.requireMain(actor);
        if (!validId(id)) { throw new BadRequestException('Некорректный ID сборки.'); }
        return this.view(actor,await this.repository.get(id));
    }
    async request(actor: IAccessActor, key: string) {
        await this.requireMain(actor);
        if (!validId(key)) {throw new BadRequestException('Некорректный ключ запроса сборки.');}
        return this.view(actor,await this.repository.findByRequest(actor.email, key));
    }
    private async view(actor:IAccessActor,row:BuildRow){const evidence=await this.repository.evidence(row.id);await this.requireMain(actor);return {...buildView(row),...evidence};}
    /** Cancellation remains available on standby and with creation disabled. */
    async cancel(actor:IAccessActor,id:string){
        await this.requireMain(actor);if(!validId(id))throw new BadRequestException('Некорректный ID сборки.');
        const row=await withBuildSqlErrors(()=>this.repository.cancel(actor.email,id,()=>this.requireMain(actor)));
        traceToolBuild('cancel-requested',{requestKey:row.request_key,buildId:row.id});
        if(row.state==='CANCELLING'&&this.activeBuild?.id===row.id)this.activeBuild.cancellation.cancel();
        void notifyDeviceOperations();return this.view(actor,row);
    }
    async cancelRequest(actor:IAccessActor,key:string){
        await this.requireMain(actor);if(!validId(key))throw new BadRequestException('Некорректный ключ запроса сборки.');
        const row=await withBuildSqlErrors(()=>this.repository.cancelRequest(actor.email,key,()=>this.requireMain(actor)));
        traceToolBuild('cancel-requested',{requestKey:key,...(row?{buildId:row.id}:{})});
        if(row?.state==='CANCELLING'&&this.activeBuild?.id===row.id)this.activeBuild.cancellation.cancel();
        void notifyDeviceOperations();return {requestKey:key,state:row?.state??'CANCELLED' as const,build:row?await this.view(actor,row):null};
    }

    /** Экспорт читает immutable source history, переживая cleanup staging и reload. */
    async exportAsset(actor:IAccessActor,id:string){
        return this.sources.exportLocal(await this.exportReference(actor,id));
    }
    private async exportReference(actor:IAccessActor,id:string){
        await this.requireMain(actor);
        if(!validId(id))throw new BadRequestException('Некорректный ID сборки.');
        const row=await this.repository.get(id),result=row.result;
        if(row.state!=='SUCCEEDED'||!result?.assetId||!result.sourceVersion||!result.sourceSha256)throw new ConflictException('Source descriptor этой сборки ещё не готов.');
        return {assetId:result.assetId,sourceVersion:result.sourceVersion,sourceSha256:result.sourceSha256};
    }
    /** HEAD checks the immutable receipt without generating a second multi-gigabyte archive. */
    async checkSupply(actor:IAccessActor,id:string){return toolSupplyPlan(await this.sources.exportLocalReceipt(await this.exportReference(actor,id)));}
    async exportSupply(actor:IAccessActor,id:string,signal:AbortSignal){const plan=await this.checkSupply(actor,id);signal.throwIfAborted();return createToolSupply(plan,this.sources.blobs,signal);}

    /** Импортирует тот же envelope и только проверяемые серверные SHA-файлы. */
    async importAsset(actor:IAccessActor,raw:unknown,requestSignal?:AbortSignal){return withToolImportDeadline(async signal=>{
        await this.requireMain(actor);
        signal.throwIfAborted();
        if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['requestKey','asset'].includes(key)))throw new BadRequestException('Импорт принимает только requestKey и asset.');
        const input=raw as {requestKey:string;asset:unknown};if(!validId(input.requestKey))throw new BadRequestException('Нужен UUID ключа импорта.');
        let checked:ReturnType<typeof validateAsset>;try{checked=validateAsset(input.asset);}catch(error){throw new BadRequestException(error instanceof Error?error.message:'Некорректный source asset.');}if(!['mcp','plugin','skill'].includes(checked.kind))throw new BadRequestException('Нужен MCP/plugin/skill asset.');
        await requireFeaturesEnabled(buildFeatures({kind:checked.kind as 'mcp'|'plugin'|'skill',source:checked.source}),undefined,undefined,signal);
        if(checked.dependencies?.length)throw new BadRequestException('Ассет с зависимостями импортируется через общий каталог с точными связанными версиями.');
        if(checked.kind==='skill')return this.importSkillAsset(actor,checked as SkillAsset,input.requestKey,signal);
        const asset=checked as ToolAsset;
        return importToolAsset(this.pool,this.artifacts,this.sources,asset,input.requestKey,actor.email,async()=>{
            signal.throwIfAborted();await this.requireMain(actor);await requireFeaturesEnabled(buildFeatures({kind:asset.kind,source:asset.source}),undefined,undefined,signal);signal.throwIfAborted();
        },signal);
    },requestSignal);}

    async publicationTarget(actor:IAccessActor,kind:unknown,catalogId:unknown){await this.requireMain(actor);const result=await publicationTargetPreview(this.pool,kind,catalogId);await this.requireMain(actor);return result;}
    async create(actor: IAccessActor, raw: unknown) {
        await this.requireMain(actor);
        const input = validateBuildInput(raw), fingerprint = requestHash(input);
        traceToolBuild('requested',{requestKey:input.requestKey});
        const previous = await this.repository.existing(actor.email, input.requestKey, fingerprint);
        if (previous) { traceToolBuild('replayed',{requestKey:input.requestKey,buildId:previous.id});return this.view(actor,previous); }
        await assertBuildCreateName(this.pool,input);
        const publication=await pinBuildPublication(this.pool,input);
        await requireFeaturesEnabled(buildFeatures(input));
        if (!this.lease || this.stopping) { throw new ServiceUnavailableException('Сборщик запускается или работает на другой реплике. Повторите запрос позже.'); }
        let source: BuildConfiguration['source'],agentCandidates:string[]=[];
        if (input.source.type === 'npm') {
            const resolved = await resolveNpmSource(input.source.specifier, input.source.entrypoint);
            agentCandidates=resolved.candidates;
            if (input.kind==='skill'||!resolved.runnableKinds.includes(input.kind)) {throw new BadRequestException('Пакет не объявляет исполняемый MCP или плагин OpenCode выбранного типа. Выберите пакет инструмента.');}
            if (!resolved.entrypoint) {throw new BadRequestException('В пакете несколько команд запуска. Выберите исполняемый файл перед упаковкой.');}
            source = {type: 'npm', ...resolved};
        }
        else if (input.source.type === 'upload') {if(!this.uploads)throw new ServiceUnavailableException('Сервис загрузки готовится к работе. Повторите позже.');source=await this.uploads.pin(actor,input.source);}
        else if (input.source.type === 'repository') {
            try {
                const resolved = await resolveRepositorySource(input.source, {metadata: !!input.agent||!input.source.entrypoint, inspectAsset: inspectGithubReleaseAsset, inspectRepository: inspectGithubRepository,inspectSkill:files=>inspectSkillSource(files,{metadataOnly:true})});
                agentCandidates=resolved.candidates;
                if(input.kind==='skill'&&(!/(?:^|\/)SKILL\.md$/.test(resolved.entrypoint)||resolved.release||resolved.runtimeSource))throw new BadRequestException('Для скилла выберите исходники с SKILL.md, без runtime или релиза.');
                if(input.kind!=='skill'&&resolved.recommendedKind==='skill')throw new BadRequestException('Источник содержит скилл. Выберите тип «Скилл».');
                if (!resolved.entrypoint) {throw new BadRequestException(resolved.requiresReleaseChoice ? 'Выберите файл релиза перед упаковкой.' : 'Выберите исполняемый файл перед упаковкой.');}
                source = validateRepositorySource({type: 'repository', url: resolved.url, commit: resolved.commit, subdirectory: resolved.subdirectory, entrypoint: resolved.entrypoint,
                    ...(resolved.runtimeSource ? {runtimeSource: resolved.runtimeSource, ...(resolved.manifestSha256 ? {manifestSha256: resolved.manifestSha256} : {})} : {}), ...(resolved.release ? {release: resolved.release} : {}), ...(resolved.snapshotSha256 ? {snapshotSha256: resolved.snapshotSha256} : {})});
            } catch (error) {throw new BadRequestException(error instanceof Error ? error.message : 'Не удалось закрепить репозиторий GitHub.');}
        } else {source = input.source;}
        const {requestKey: _requestKey, publication:_publication, ...configuration} = input;
        if(source.type==='files')agentCandidates=source.files.filter(file=>isSourceEntrypoint(file.path)&&file.content.trim()).map(file=>file.path);
        let config: BuildConfiguration = {...configuration, source,...(input.agent?{agentCandidates:[...new Set([source.entrypoint,...agentCandidates])].slice(0,32)}:{}),...(publication?{publication}:{})};
        assertCodexBuildKind(config);if(isPreparedCodexRepository(config.source))await requireFeaturesEnabled(buildFeatures(config));
        if (source.type === 'npm' && source.recommendedKind && source.recommendedKind !== input.kind) { throw new BadRequestException(`Этот пакет устанавливается как ${source.recommendedKind === 'mcp' ? 'MCP' : 'плагин'}. Измените тип инструмента.`); }
        if (source.type === 'npm' && source.supportedTargets) {
            if (!Object.prototype.hasOwnProperty.call(raw, 'targets')) {config.targets = [...source.supportedTargets];}
            else if (config.targets.some(target => !source.supportedTargets!.includes(target))) {throw new BadRequestException('Для этого пакета нет готового адаптера одной из выбранных платформ. Выберите поддерживаемые платформы.');}
        }
        if (source.type === 'upload') {
            if(input.kind!=='mcp')throw new BadRequestException('Автономная поставка поддерживает MCP.');
            const supported=runtimeSourceTargets(source.runtimeSource);
            if(!Object.prototype.hasOwnProperty.call(raw,'targets'))config.targets=supported;
            else if(config.targets.some(target=>!supported.includes(target as typeof supported[number])))throw new BadRequestException('Архив не поддерживает одну из выбранных платформ.');
        }
        if (source.type === 'repository' && source.runtimeSource) {
            if (input.kind !== 'mcp') {throw new BadRequestException('Поставка описывает автономный MCP. Измените тип инструмента.');}
            const supported = runtimeSourceTargets(source.runtimeSource);
            if (!Object.prototype.hasOwnProperty.call(raw, 'targets')) {config.targets = supported;}
            else if (config.targets.some(target => !supported.includes(target as typeof supported[number]))) {throw new BadRequestException('В поставке нет комплекта для одной из выбранных платформ. Выберите поддерживаемые платформы.');}
        }
        if (source.type === 'repository' && isPreparedRagRepository(source)) {
            if (input.kind !== 'plugin') {throw new BadRequestException('OpenCodeRAG из этого репозитория устанавливается как плагин. Для MCP используйте отдельную карточку OpenCodeRAG.');}
            const supported = RAG_PLUGIN_SOURCE.supportedTargets;
            if (!Object.prototype.hasOwnProperty.call(raw, 'targets')) {config.targets = [...supported];}
            else if (config.targets.some(target => !supported.includes(target as typeof supported[number]))) {throw new BadRequestException('Для плагина OpenCodeRAG нет готового комплекта Intel Mac. Выберите поддерживаемые платформы.');}
        }
        if(config.agent){
            let enabled=true;
            try{await requireFeaturesEnabled(['tool_build_agent_recipes']);}catch(error){if(error instanceof ForbiddenException)enabled=false;else throw error;}
            config=await pinBuildRecipe(config,await this.stagingRoot(),enabled);
        }
        await this.requireMain(actor);
        const lease = this.currentLease();
        return withBuildSqlErrors(()=>this.withLease(lease, async () => {
            const root = await this.stagingRoot();
            let releaseDb: () => void = () => undefined;
            try {
                releaseDb = await reserveCapacity({resource: 'postgres', bytes: Buffer.byteLength(JSON.stringify(config)) + 131072});
                await this.requireMain(actor);
                await requireFeaturesEnabled(buildFeatures(config));
                this.currentLease(lease);
                const retain=async(client:PoolClient)=>{
                    await this.requireMain(actor);await requireFeaturesEnabled(buildFeatures(config));this.currentLease(lease);
                    if(publication){await lockBuildPublication(client,publication);await this.requireMain(actor);await requireFeaturesEnabled(buildFeatures(config));this.currentLease(lease);}
                    if(source.type==='upload')await this.uploads!.retain(client,actor.email,source);
                };
                const row=await this.repository.enqueue(actor.email,input.requestKey,fingerprint,config,lease,retain);
                traceToolBuild('accepted',{requestKey:input.requestKey,buildId:row.id});
                this.currentLease(lease);
                if (row.state === 'QUEUED') {this.startWorker(root);}
                void notifyDeviceOperations();
                return buildView(row);
            } finally {
                releaseDb();
            }
        }));
    }

    /** Флаг закрывает гонку: новый запрос мог прийти между пустой выборкой и завершением worker. */
    private startWorker(root: string): void {
        this.queueRequested = true;
        if (this.worker || this.stopping || !this.lease) {return;}
        this.queueRequested = false;
        const worker = this.drainQueue(root).catch(() => {
            if (this.stopping) {return;}
            this.logger.warn('Обработка очереди прервана; восстановим владельца и продолжим ожидающие сборки.');
            // Ошибка отдельного SQL-запроса не всегда вызывает client.error: освобождаем lease сами.
            const release = this.releaseLease;
            this.lease = undefined; this.releaseLease = undefined;
            release?.(true);
            this.scheduleOwnershipRetry();
        }).finally(() => {
            if (this.worker === worker) {this.worker = undefined;}
            if (this.queueRequested && !this.stopping && this.lease) {this.startWorker(root);}
        });
        this.worker = worker;
    }

    private async drainQueue(root: string): Promise<void> {
        while (this.lease && !this.stopping) {
            const lease = this.currentLease();
            const row = await this.withLease(lease, () => this.repository.takeQueued(lease));
            if (!row) {if(await this.cleanupStages()){await new Promise(resolve=>setTimeout(resolve,500));continue;}return;}
            await this.execute(row, root);
        }
    }

    private async stagingRoot(): Promise<string> {
        const root = path.join(runtimeArtifactDirectory(), '.build-staging');
        await fs.mkdir(root, {recursive: true, mode: 0o700});
        const info = await fs.lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink()) { throw new ConflictException('Каталог серверной сборки недоступен.'); }
        return root;
    }

    /** Удаляются только каталоги известных завершённых UUID; ссылки не разыменовываются. */
    private async cleanupStages(): Promise<boolean> {
        return cleanupBuildStages(this.repository,path.join(runtimeArtifactDirectory(),'.build-staging'),this.stoppedWorkers);
    }

    private async execute(row: BuildRow, root: string): Promise<void> {
        const stage = path.join(root, row.id);
        const cancellation=new BuildCancellation(()=>this.repository.get(row.id));
        this.activeBuild={id:row.id,cancellation};let cancelled=false,unreaped=false,started=false,reaped=false,succeeded=false,cancellationComplete=false,failureComplete=false;
        traceToolBuild('started',{requestKey:row.request_key,buildId:row.id});
        let releaseDisk: () => void = () => undefined;
        try {
            await this.requireMain({email: row.actor, activeRole: 'Главный админ'}); await requireFeaturesEnabled(buildFeatures(row.config));
            if (!this.lease || this.stopping) { throw new Error('Сборщик останавливается.'); }
            releaseDisk = await reserveCapacity({resource: 'runtime-artifacts', bytes: row.config.kind==='skill'&&row.config.source.type==='files'?64*1024**2:stagingLimit, path: root});
            await fs.mkdir(stage, {mode: 0o700});
            await this.progress(row.id, 10, 'Подготовка исходников и закреплённой версии');
            if(row.config.kind==='skill'){await this.executeSkill(row,stage);succeeded=true;return;}
            await this.progress(row.id, 30, 'Сборка платформенных комплектов и проверка SHA');
            if(row.config.source.type==='upload'){if(!this.uploads)throw new Error('Сервис сохранённых исходников недоступен.');await this.uploads.assertRetained(row.actor,row.config.source);}
            const ownerLease=this.currentLease(),actor={email:row.actor,activeRole:'Главный админ' as const};
            const authorize=async()=>{
                cancellation.assertActive();this.currentLease(ownerLease);await this.requireMain(actor);await requireFeaturesEnabled(buildFeatures(row.config));
                const current=await this.repository.get(row.id);
                if(current.state==='CANCELLING'||current.state==='CANCELLED')throw new BuildCancelledError();
                if(current.state!=='RUNNING'||current.execution_nonce!==row.execution_nonce||current.publication_started_at)throw new ConflictException('Сборка потеряла владельца.');
                this.currentLease(ownerLease);cancellation.assertActive();
            };
            const verified=await buildVerifiedAttempts(row.config,{
                agent:this.agent,authorize,identity:attempt=>`${row.id}:${attempt}:${row.execution_nonce}`,
                context:(attempt,feedback)=>({buildId:row.id,executionNonce:row.execution_nonce!,actorEmail:row.actor,actorRole:'Главный админ',attempt,signal:cancellation.controller.signal,
                    candidates:row.config.agentCandidates??[row.config.source.entrypoint],feedback,requiredFeatures:buildFeatures(row.config),authorize,
                    transaction:work=>this.withLease(ownerLease,()=>this.repository.agentTransaction(ownerLease,work))}),
                reset:async()=>{
                    await authorize();if(started&&!reaped)throw new BuildProcessUnreapedError();
                    await fs.rm(stage,{recursive:true,force:true});await forgetBuildCleanup(root,row);
                    row.execution_nonce=await this.withLease(ownerLease,()=>this.repository.nextAttempt(row.id,row.execution_nonce!,ownerLease));
                    started=false;reaped=false;this.child=undefined;await fs.mkdir(stage,{mode:0o700});
                },
                build:(config,attempt)=>runPackageBuilder(config,stage,child=>{
                    this.child=child;cancellation.observe(child);if(child&&(this.stopping||!this.lease))stopBuildProcess(child);
                },event=>this.progress(row.id,30+Math.floor(30*event.completed/event.total),`Попытка ${attempt}: собрано ${event.completed}/${event.total}: ${event.target}`),cancellation.controller.signal,
                {nonce:row.execution_nonce!,reaped:()=>{reaped=true;},markStarted:async()=>{await authorize();await this.withLease(ownerLease,()=>this.repository.markExecutionStarted(row.id,row.execution_nonce!,ownerLease));started=true;}}).catch(async error=>{
                    if(error instanceof BuildDiagnosticError)await this.withLease(ownerLease,()=>this.repository.recordBuildDiagnostic(row.id,row.execution_nonce!,attempt,error.report,ownerLease));
                    throw error;
                }),
                verify:async(manifest,identity)=>{await this.progress(row.id,65,'Проверка запуска MCP/plugin в изолированном профиле');return verifyBuildRuntime(manifest,identity,cancellation.controller.signal);},
                record:(attempt,report)=>this.withLease(ownerLease,()=>this.repository.recordRuntime(row.id,row.execution_nonce!,attempt,report,ownerLease)),
            });
            const manifest=verified.manifest;
            cancellation.assertActive();
            if (!this.lease || this.stopping) { throw new Error('Сборщик остановлен.'); }
            await this.requireMain({email: row.actor, activeRole: 'Главный админ'});
            await this.progress(row.id, 70, 'Импорт проверенных готовых комплектов');
            const {readyManifest} = createRequire(__filename)(path.join(path.dirname(builderScript()), 'manifest.mjs')) as {readyManifest: (file: string) => Promise<PreparedTool[]>};
            const tools = await readyManifest(manifest);
            await assertRuntimeCandidate(manifest,verified.report,verified.identity);
            if (tools.length !== 1 || tools[0].publication.name !== row.config.name || tools[0].publication.kind !== row.config.kind) { throw new Error('Сборщик вернул другой инструмент.'); }
            assertCodexBuildPublication(row.config,tools[0].publication);
            await authorize();
            // The verified producer is reaped; statfs now includes its retained staging bytes.
            if(started&&reaped&&!this.child){releaseDisk();releaseDisk=()=>undefined;}
            for (const artifact of tools[0].artifacts) { if(isPreparedCodexRepository(row.config.source))await requireFeaturesEnabled(buildFeatures(row.config));await this.artifacts.importArchive(artifact.archivePath, artifact.descriptor); }
            const sourcePath=tools[0].sourceSnapshotPath;
            if(tools[0].asset.source.type==='archive'&&!sourcePath)throw new Error('Сборщик не вернул путь проверенного исходника.');
            const prepared=await this.sources.prepareLocal(tools[0].asset,tools[0].artifacts.map(({archivePath,descriptor})=>{const item=descriptor as {sha256:string;compressedBytes:number;target:string};return {archivePath,sha256:item.sha256,bytes:item.compressedBytes,filename:item.sha256+'.tar.gz',target:item.target};}),row.request_key,undefined,sourcePath?{archivePath:sourcePath,stagingRoot:path.dirname(sourcePath)}:undefined);
            await this.progress(row.id, 95, 'Публикация карточки и связанной версии ассета');
            const lease = this.lease;
            if (!lease || this.stopping) { throw new Error('Сборщик остановлен до публикации.'); }
            // COMMIT использует сессию advisory lock: потеря lease откатывает старую публикацию.
            await this.withLease(lease, async () => {
                await this.requireMain({email: row.actor, activeRole: 'Главный админ'});
                if(row.config.source.type==='upload')await this.uploads!.assertRetained(row.actor,row.config.source);
                if(isPreparedCodexRepository(row.config.source))await requireFeaturesEnabled(buildFeatures(row.config));
                this.currentLease(lease);
                await assertRuntimeCandidate(manifest,verified.report,verified.identity);
                await this.repository.beginPublication(row.id,lease,async()=>{await this.requireMain({email:row.actor,activeRole:'Главный админ'});await requireFeaturesEnabled(buildFeatures(row.config));this.currentLease(lease);});
                await publishBuiltTool({pool:this.pool,lease,sources:this.sources,repository:this.repository,row,publication:tools[0].publication,prepared,
                    guard:async()=>{await this.requireMain({email:row.actor,activeRole:'Главный админ'});await requireFeaturesEnabled(buildFeatures(row.config));this.currentLease(lease);},discard:client=>this.discardLease(client)});
            });
            await fetch((process.env.API_GATEWAY_URL || 'http://localhost:4000') + '/internal/events', {
                method: 'POST', headers: {'Content-Type': 'application/json', 'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || ''},
                body: JSON.stringify({sections: ['catalog', 'operations', 'audit']}), signal: AbortSignal.timeout(1500),
            }).catch(() => undefined);
            succeeded=true;
        } catch (error) {
            unreaped=error instanceof BuildProcessUnreapedError;
            const message = publicationDeadlineMessage(error) ?? (error instanceof ForbiddenException ? (error.message.startsWith('Функция «')?error.message:'Права главного администратора отозваны. Публикация остановлена.')
                : error instanceof Error && !/postgres|password|token|secret|connection|https?:\/\//i.test(error.message) ? error.message.slice(0, 500)
                : 'Сборка не выполнена. Проверьте исходники, зависимости и доступность npm.');
            cancelled=error instanceof BuildCancelledError||cancellation.controller.signal.reason instanceof BuildCancelledError;
            if(!cancelled)try{failureComplete=(await this.repository.progress(row.id, 'FAILED', 0, message, undefined, message))?.state==='FAILED';}
            catch(failure){if(failure instanceof BuildCancelledError)cancelled=true;else throw failure;}
            if(cancelled&&started&&!reaped)unreaped=true;
        } finally {
            this.child = undefined;
            cancellation.dispose();if(this.activeBuild?.id===row.id)this.activeBuild=undefined;
            try {if(unreaped){if(cancelled)await this.repository.cancellationAwaitingOwner(row.id);}else{if(row.execution_nonce)this.stoppedWorkers.add(row.execution_nonce);await fs.rm(stage, {recursive: true, force: true});if(cancelled){await acknowledgeBuildCleanup(root,row);cancellationComplete=await this.repository.completeCancellation(row.id);}await forgetBuildCleanup(root,row);if(row.execution_nonce)this.stoppedWorkers.delete(row.execution_nonce);}}
            catch(error){succeeded=false;cancellationComplete=false;failureComplete=false;if(cancelled)await this.repository.cancellationCleanupFailed(row.id);throw error;}
            // An unreaped producer can still grow its stage; keep its process-local reservation for operator recovery.
            finally {if(!unreaped)releaseDisk();if(!unreaped&&(cancelled?cancellationComplete:succeeded||failureComplete))traceToolBuild(cancelled?'cancelled':succeeded?'succeeded':'failed',{requestKey:row.request_key,buildId:row.id});}
            void notifyDeviceOperations();
        }
    }

    private async progress(id: string, percent: number, message: string): Promise<void> {
        await this.repository.progress(id, 'RUNNING', percent, message);
        void notifyDeviceOperations();
    }

    /** Native skill write is journaled before Catalog atomically commits its source receipt and build result. */
    private async executeSkill(row:BuildRow,stage:string):Promise<void>{
        const built=await buildSkillAsset(row.config,stage);
        await this.progress(row.id,60,'Проверка SKILL.md, ресурсов и связанной версии ассета');
        const prepared=await this.sources.prepareLocalSkill(built.asset,row.request_key,built.sourceFile,{createOnly:true}),lease=this.currentLease();
        await this.withLease(lease,async()=>{
            const guard=async()=>{await this.requireMain({email:row.actor,activeRole:'Главный админ'});await requireFeaturesEnabled(buildFeatures(row.config));this.currentLease(lease);};
            await guard();await this.repository.beginPublication(row.id,lease,guard);
            await lease.query('BEGIN');
            try{
                await configureBuildPublicationTransaction(lease);
                await lease.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:skill:common/'+built.asset.card.slug]);
                await authorizeImportActor(lease,row.actor,true);await guard();
                const native=await this.sources.publishLocalSkill(prepared,row.actor);
                await guard();
                const source=await this.sources.recordLocalSkill(lease,prepared,native,row.actor);
                await this.repository.completeWithPublication(lease,row.id,{catalogId:native.id,name:built.asset.card.name,version:native.version,kind:'skill',...source});
                await guard();await lease.query('COMMIT');
            }catch(error){try{await lease.query('ROLLBACK');}catch{this.discardLease(lease);}throw error;}
        });
        await this.notifySkillPublication();
    }
    private async importSkillAsset(actor:IAccessActor,asset:SkillAsset,requestKey:string,signal?:AbortSignal){
        return importBuiltSkill(this.pool,this.sources,asset,requestKey,actor.email,async()=>{signal?.throwIfAborted();await this.requireMain(actor);await requireFeaturesEnabled(['tool_builds',...requiredAssetFeatures('skill')],undefined,undefined,signal);signal?.throwIfAborted();},()=>this.notifySkillPublication());
    }
    private async notifySkillPublication(){
        await fetch((process.env.API_GATEWAY_URL||'http://localhost:4000')+'/internal/events',{
            method:'POST',headers:{'content-type':'application/json','x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''},
            body:JSON.stringify({sections:['skills','catalog','operations','audit']}),signal:AbortSignal.timeout(1500),
        }).catch(()=>undefined);
    }
}
