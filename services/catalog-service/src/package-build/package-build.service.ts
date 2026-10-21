import {SourceUploadService} from '../source-upload/source-upload.service';
import { inspectGithubReleaseAsset, inspectGithubRepository } from '../../../shared/release-inspection.cjs';
import { ConflictException, ForbiddenException, Injectable, Optional, OnModuleDestroy, OnModuleInit, ServiceUnavailableException, BadRequestException, Logger } from '@nestjs/common';
import { createRequire } from 'node:module';
import type {ToolAsset,SkillAsset} from '@neurocenter/asset-contract';
import {validateAsset,toToolPublication} from '@neurocenter/asset-contract';
import {createHash} from 'node:crypto';
import {AssetSourcesService} from '../asset-sources/asset-sources.service';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { PoolClient } from 'pg';
import { AccessDb } from '../access/access-db';
import type { IAccessActor } from '../access/access.model';
import { createPool } from '../database/pool';
import { notifyDeviceOperations } from '../devices/device-operations';
import { PluginRepository } from '../publication/plugin-repository';
import type { IAiPluginCreate } from '../catalog/dto';
import { CatalogService } from '../catalog/catalog.service';
import { RuntimeArtifacts, runtimeArtifactDirectory } from '../runtime-artifacts/runtime-artifacts';
import { reserveCapacity } from '../../../shared/capacity.cjs';
import { resolveRepositorySource, validateRepositorySource, type RepositoryInput } from '../../../shared/repository-source.cjs';
import { runtimeSourceTargets } from '../../../shared/tool-runtime-source.cjs';
import { RAG_PLUGIN_SOURCE, isPreparedRagRepository } from '../../../shared/opencode-rag-source.cjs';
import { builderScript, runPackageBuilder, stagingLimit, stopBuildProcess } from './build-process';
import { resolveNpmSource } from './npm-source';
import { readSourceArchive } from './source-archive';
import { PackageBuildRepository } from './package-build.repository';
import { buildView, requestHash, validId, validateBuildInput, type BuildConfiguration, type BuildRow } from './package-build.model';
import {createToolSupply,toolSupplyPlan} from './supply-export';
import {inspectSkillSource} from './skill-source';
import {buildSkillAsset} from './build-skill';

interface PreparedTool {asset:ToolAsset;publication: IAiPluginCreate; artifacts: Array<{archivePath: string; descriptor: unknown}>;sourceSnapshotPath?:string}

/** Один владелец исполняет очередь последовательно; после рестарта продолжаются ещё не начатые задания. */
@Injectable()
export class PackageBuildService implements OnModuleInit, OnModuleDestroy {
    private readonly pool = createPool({connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog', max: 3}, 'package-build');
    private readonly repository = new PackageBuildRepository(this.pool);
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
    private stopping = false;

    constructor(private readonly access: AccessDb, private readonly artifacts: RuntimeArtifacts, private readonly catalog: CatalogService,private readonly sources:AssetSourcesService,@Optional() private readonly uploads?:SourceUploadService) {}

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

    /** На lease-сессии не пересекаются BEGIN приёма и публикации; gate включает передачу worker. */
    private withLease<T>(expected: PoolClient, work: () => Promise<T>): Promise<T> {
        const pending = this.leaseUse.then(async () => {
            this.currentLease(expected);
            try {return await work();}
            catch (error) {this.currentLease(expected); throw error;}
        });
        this.leaseUse = pending.then(() => undefined, () => undefined);
        return pending;
    }

    async requireMain(actor: IAccessActor): Promise<void> {
        const claims = await this.access.claims(actor?.email);
        if (actor?.activeRole !== 'Главный админ' || !claims.userRoles.includes('Главный админ')) { throw new ForbiddenException('Собирать и публиковать инструменты может главный администратор.'); }
    }

    async npm(actor: IAccessActor, specifier: unknown, entrypoint?: string) {
        await this.requireMain(actor);
        return resolveNpmSource(specifier, entrypoint);
    }
    async archiveSource(actor: IAccessActor, input: unknown) {
        await this.requireMain(actor);
        return readSourceArchive(input);
    }
    async repositorySource(actor: IAccessActor, input: Omit<RepositoryInput, 'type'>) {
        await this.requireMain(actor);
        try {return await resolveRepositorySource(input, {inspectAsset: inspectGithubReleaseAsset, inspectRepository: inspectGithubRepository,inspectSkill:files=>inspectSkillSource(files,{metadataOnly:true})});}
        catch (error) {throw new BadRequestException(error instanceof Error ? error.message : 'Не удалось проверить репозиторий GitHub.');}
    }

    async get(actor: IAccessActor, id: string) {
        await this.requireMain(actor);
        if (!validId(id)) { throw new BadRequestException('Некорректный ID сборки.'); }
        return buildView(await this.repository.get(id));
    }
    async request(actor: IAccessActor, key: string) {
        await this.requireMain(actor);
        if (!validId(key)) {throw new BadRequestException('Некорректный ключ запроса сборки.');}
        return buildView(await this.repository.findByRequest(actor.email, key));
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
    async importAsset(actor:IAccessActor,raw:unknown){
        await this.requireMain(actor);
        if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['requestKey','asset'].includes(key)))throw new BadRequestException('Импорт принимает только requestKey и asset.');
        const input=raw as {requestKey:string;asset:unknown};if(!validId(input.requestKey))throw new BadRequestException('Нужен UUID ключа импорта.');
        let checked:ReturnType<typeof validateAsset>;try{checked=validateAsset(input.asset);}catch(error){throw new BadRequestException(error instanceof Error?error.message:'Некорректный source asset.');}if(!['mcp','plugin','skill'].includes(checked.kind))throw new BadRequestException('Нужен MCP/plugin/skill asset.');
        if(checked.dependencies?.length)throw new BadRequestException('Ассет с зависимостями импортируется через общий каталог с точными связанными версиями.');
        if(checked.kind==='skill')return this.importSkillAsset(actor,checked as SkillAsset,input.requestKey);
        const asset=checked as ToolAsset,files=asset.delivery.artifacts.map(({descriptor})=>({archivePath:path.join(runtimeArtifactDirectory(),descriptor.sha256+'.tar.gz'),sha256:descriptor.sha256,bytes:descriptor.compressedBytes,filename:descriptor.sha256+'.tar.gz',target:descriptor.target}));
        for(const [index,file]of files.entries()){
            try{await this.artifacts.importArchive(file.archivePath,asset.delivery.artifacts[index].descriptor);}catch{throw new ConflictException('Проверенный архив поставки отсутствует или повреждён. Загрузите исходную поставку повторно.');}
        }
        const prepared=await this.sources.prepareLocal(asset,files,input.requestKey),bytes=createHash('sha256').update('neurocenter-source-asset\0'+asset.id+'\0'+asset.version).digest().subarray(0,16);
        bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=bytes.toString('hex'),publicationKey=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
        let result:unknown;
        const saved=await new PluginRepository(this.pool).create({...toToolPublication(asset),publicationKey} as IAiPluginCreate,actor.email,async(client,card)=>{
            await this.requireMain(actor);const source=await this.sources.recordLocal(client,prepared,card,actor.email);result={catalogId:card.id,name:card.name,version:card.version,...source};
        });
        return result||{catalogId:saved.id,name:saved.name,version:saved.version};
    }

    async create(actor: IAccessActor, raw: unknown) {
        await this.requireMain(actor);
        const input = validateBuildInput(raw), fingerprint = requestHash(input);
        const previous = await this.repository.existing(actor.email, input.requestKey, fingerprint);
        if (previous) { return buildView(previous); }
        if (!this.lease || this.stopping) { throw new ServiceUnavailableException('Сборщик запускается или работает на другой реплике. Повторите запрос позже.'); }
        let source: BuildConfiguration['source'];
        if (input.source.type === 'npm') {
            const resolved = await resolveNpmSource(input.source.specifier, input.source.entrypoint);
            if (input.kind==='skill'||!resolved.runnableKinds.includes(input.kind)) {throw new BadRequestException('Пакет не объявляет исполняемый MCP или плагин OpenCode выбранного типа. Выберите пакет инструмента.');}
            if (!resolved.entrypoint) {throw new BadRequestException('В пакете несколько команд запуска. Выберите исполняемый файл перед упаковкой.');}
            source = {type: 'npm', ...resolved};
        }
        else if (input.source.type === 'upload') {if(!this.uploads)throw new ServiceUnavailableException('Сервис загрузки готовится к работе. Повторите позже.');source=await this.uploads.pin(actor,input.source);}
        else if (input.source.type === 'repository') {
            try {
                const resolved = await resolveRepositorySource(input.source, {metadata: !input.source.entrypoint, inspectAsset: inspectGithubReleaseAsset, inspectRepository: inspectGithubRepository,inspectSkill:files=>inspectSkillSource(files,{metadataOnly:true})});
                if(input.kind==='skill'&&(!/(?:^|\/)SKILL\.md$/.test(resolved.entrypoint)||resolved.release||resolved.runtimeSource))throw new BadRequestException('Для скилла выберите исходники с SKILL.md, без runtime или релиза.');
                if(input.kind!=='skill'&&resolved.recommendedKind==='skill')throw new BadRequestException('Источник содержит скилл. Выберите тип «Скилл».');
                if (!resolved.entrypoint) {throw new BadRequestException(resolved.requiresReleaseChoice ? 'Выберите файл релиза перед упаковкой.' : 'Выберите исполняемый файл перед упаковкой.');}
                source = validateRepositorySource({type: 'repository', url: resolved.url, commit: resolved.commit, subdirectory: resolved.subdirectory, entrypoint: resolved.entrypoint,
                    ...(resolved.runtimeSource ? {runtimeSource: resolved.runtimeSource, ...(resolved.manifestSha256 ? {manifestSha256: resolved.manifestSha256} : {})} : {}), ...(resolved.release ? {release: resolved.release} : {}), ...(resolved.snapshotSha256 ? {snapshotSha256: resolved.snapshotSha256} : {})});
            } catch (error) {throw new BadRequestException(error instanceof Error ? error.message : 'Не удалось закрепить репозиторий GitHub.');}
        } else {source = input.source;}
        const {requestKey: _requestKey, ...configuration} = input;
        const config: BuildConfiguration = {...configuration, source};
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
        await this.requireMain(actor);
        const lease = this.currentLease();
        return this.withLease(lease, async () => {
            const root = await this.stagingRoot();
            let releaseDb: () => void = () => undefined;
            try {
                releaseDb = await reserveCapacity({resource: 'postgres', bytes: Buffer.byteLength(JSON.stringify(config)) + 131072});
                await this.requireMain(actor);
                this.currentLease(lease);
                const row = source.type==='upload'
                    ? await this.repository.enqueue(actor.email,input.requestKey,fingerprint,config,lease,client=>this.uploads!.retain(client,actor.email,source))
                    : await this.repository.enqueue(actor.email,input.requestKey,fingerprint,config,lease);
                this.currentLease(lease);
                if (row.state === 'QUEUED') {this.startWorker(root);}
                void notifyDeviceOperations();
                return buildView(row);
            } finally {
                releaseDb();
            }
        });
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
            if (!row) {return;}
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
    private async cleanupStages(): Promise<void> {
        const root = path.join(runtimeArtifactDirectory(), '.build-staging');
        let entries: import('node:fs').Dirent[];
        try {
            const info = await fs.lstat(root);
            if (!info.isDirectory() || info.isSymbolicLink()) {throw new Error('Небезопасный каталог серверной сборки.');}
            entries = await fs.readdir(root, {withFileTypes: true});
        } catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return;} throw error;}
        const ids = entries.filter(entry => validId(entry.name)).map(entry => entry.name);
        if (!ids.length) {return;}
        const {rows} = await this.pool.query<{id: string}>("SELECT id FROM tool_build_jobs WHERE id=ANY($1::uuid[]) AND state IN ('FAILED','SUCCEEDED')", [ids]);
        for (const row of rows) {await fs.rm(path.join(root, row.id), {recursive: true, force: true});}
    }

    private async execute(row: BuildRow, root: string): Promise<void> {
        const stage = path.join(root, row.id);
        let releaseDisk: () => void = () => undefined;
        try {
            await this.requireMain({email: row.actor, activeRole: 'Главный админ'});
            if (!this.lease || this.stopping) { throw new Error('Сборщик останавливается.'); }
            releaseDisk = await reserveCapacity({resource: 'runtime-artifacts', bytes: row.config.kind==='skill'&&row.config.source.type==='files'?64*1024**2:stagingLimit, path: root});
            await fs.mkdir(stage, {mode: 0o700});
            await this.progress(row.id, 10, 'Подготовка исходников и закреплённой версии');
            if(row.config.kind==='skill'){await this.executeSkill(row,stage);return;}
            await this.progress(row.id, 30, 'Сборка платформенных комплектов и проверка SHA');
            if(row.config.source.type==='upload'){if(!this.uploads)throw new Error('Сервис сохранённых исходников недоступен.');await this.uploads.assertRetained(row.actor,row.config.source);}
            const manifest = await runPackageBuilder(row.config, stage, child => {
                this.child = child;
                if (child && (this.stopping || !this.lease)) {stopBuildProcess(child);}
            }, event =>
                this.progress(row.id, 30 + Math.floor(30 * event.completed / event.total), `Собрано ${event.completed}/${event.total}: ${event.target}`));
            if (!this.lease || this.stopping) { throw new Error('Сборщик остановлен.'); }
            await this.requireMain({email: row.actor, activeRole: 'Главный админ'});
            await this.progress(row.id, 70, 'Импорт проверенных готовых комплектов');
            const {readyManifest} = createRequire(__filename)(path.join(path.dirname(builderScript()), 'manifest.mjs')) as {readyManifest: (file: string) => Promise<PreparedTool[]>};
            const tools = await readyManifest(manifest);
            if (tools.length !== 1 || tools[0].publication.name !== row.config.name || tools[0].publication.kind !== row.config.kind) { throw new Error('Сборщик вернул другой инструмент.'); }
            for (const artifact of tools[0].artifacts) { await this.artifacts.importArchive(artifact.archivePath, artifact.descriptor); }
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
                this.currentLease(lease);
                await new PluginRepository(this.pool).create(tools[0].publication,row.actor,async(client,published)=>{
                    const source=await this.sources.recordLocal(client,prepared,published,row.actor);
                    await this.repository.completeWithPublication(client,row.id,{catalogId:published.id,name:published.name,version:published.version,...source});
                },lease);
            });
            await fetch((process.env.API_GATEWAY_URL || 'http://localhost:4000') + '/internal/events', {
                method: 'POST', headers: {'Content-Type': 'application/json', 'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || ''},
                body: JSON.stringify({sections: ['catalog', 'operations', 'audit']}), signal: AbortSignal.timeout(1500),
            }).catch(() => undefined);
        } catch (error) {
            const message = error instanceof ForbiddenException ? 'Права главного администратора отозваны. Публикация остановлена.'
                : error instanceof Error && !/postgres|password|token|secret|connection|https?:\/\//i.test(error.message) ? error.message.slice(0, 500)
                : 'Сборка не выполнена. Проверьте исходники, зависимости и доступность npm.';
            await this.repository.progress(row.id, 'FAILED', 0, message, undefined, message);
        } finally {
            this.child = undefined;
            try {await fs.rm(stage, {recursive: true, force: true});}
            finally {releaseDisk();}
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
        const prepared=await this.sources.prepareLocalSkill(built.asset,row.request_key,built.sourceFile),lease=this.currentLease();
        await this.withLease(lease,async()=>{
            await this.requireMain({email:row.actor,activeRole:'Главный админ'});this.currentLease(lease);
            await lease.query('BEGIN');
            try{
                await lease.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:skill:common/'+built.asset.card.slug]);
                const native=await this.sources.publishLocalSkill(prepared,row.actor);
                await this.requireMain({email:row.actor,activeRole:'Главный админ'});this.currentLease(lease);
                const source=await this.sources.recordLocalSkill(lease,prepared,native,row.actor);
                await this.repository.completeWithPublication(lease,row.id,{catalogId:native.id,name:built.asset.card.name,version:native.version,kind:'skill',...source});
                this.currentLease(lease);await lease.query('COMMIT');
            }catch(error){await lease.query('ROLLBACK').catch(()=>undefined);throw error;}
        });
        await this.notifySkillPublication();
    }
    private async importSkillAsset(actor:IAccessActor,asset:SkillAsset,requestKey:string){
        const prepared=await this.sources.prepareLocalSkill(asset,requestKey);
        await this.requireMain(actor);
        const client=await this.pool.connect();
        try{
            await client.query('BEGIN');await this.requireMain(actor);
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:skill:common/'+asset.card.slug]);
            const native=await this.sources.publishLocalSkill(prepared,actor.email);await this.requireMain(actor);
            const source=await this.sources.recordLocalSkill(client,prepared,native,actor.email);await client.query('COMMIT');
            await this.notifySkillPublication();return {catalogId:native.id,name:asset.card.name,version:native.version,kind:'skill' as const,...source};
        }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
    }
    private async notifySkillPublication(){
        await fetch((process.env.API_GATEWAY_URL||'http://localhost:4000')+'/internal/events',{
            method:'POST',headers:{'content-type':'application/json','x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''},
            body:JSON.stringify({sections:['skills','catalog','operations','audit']}),signal:AbortSignal.timeout(1500),
        }).catch(()=>undefined);
    }
}
