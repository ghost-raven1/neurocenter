import {reindexHostedRag} from '../features/rag-hosted/reindex.js';
import {finalizeRagReindex,releaseRagReindex,recoverRagRestore} from '../features/rag-index/restore-recovery.js';
import {probeInstalledRagMcp} from '../features/rag-ui/mcp-startup.js';
import {localRagUi} from '../features/rag-ui/contract.js';
import {openRagUi,closeRagUis,closeOwnRagUi} from '../features/rag-ui/index.js';
import { PROJECT_LOCAL_KINDS, PROJECT_LOCAL_APPLIES, runProjectLocalJob, type ProjectLocalPayload } from './project-local-worker.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { io } from 'socket.io-client';
import {
    api,
    hub,
    readState,
    writeState,
    stateDir,
    jobContext,
    type Credentials,
} from './state.js';
import {
    chooseRoot,
    prepareProjectBinding,
    commitProjectBinding,
    recoverPendingWorkspaceIdentity,
    workspaceReport,
    projectFolder,
    projectBindingId,
    type WorkspaceBindingMode,
    type WorkspaceBindingPreparation,
} from './workspace.js';
import { install, installSet } from './installer.js';
import { packageRef, sortedRefs, type InstallSet } from './install-set.js';
import {uninstall} from './uninstaller.js';
import type { Package } from './package.js';
import { inspectInstallation } from './installation-inspection.js';
import { assertInspectionIdentity } from './inspection-identity.js';
import { deliverCompletions, pendingCompletions, saveCompletion } from './completions.js';
import { recoverFileJobs } from './installation-files.js';
import { BRIDGE_VERSION, bridgeBuildId } from './protocol.js';
import { waitForWorkerInstallation } from './worker-upgrade.js';
import { readBoundedUtf8 } from './read-bounded.js';
import { verifyWorkspaceInstallations } from './workspace-installations.js';
import { runRuntimeProbe } from '../features/runtime-probe/index.js';
import { runtimeProbeEngine } from './runtime-engine.js';
import { openLocalRecoveryFolder } from './open-local-recovery.js';
import { prepareLocalChange, applyLocalChange } from './local-change-plan.js';
import { openLocalChangeReport } from './local-change-report.js';
import { CONFIGURATION_KINDS, runMcpConfigurationJob,prepareJobMcpLaunchers,type ConfigurationPayload } from './mcp-configuration-worker.js';
import { prepareJobRuntimeArtifacts } from './job-runtime-artifacts.js';
import { recoverRuntimePreparations, runtimePreparationCompletion } from './runtime-preparation-intent.js';
import { runRagBridgeJob } from './rag-worker.js';
import { recoverRagRestores } from '../features/rag-index/restore-recovery.js';
import type { ConfigurationRevision } from '../features/runtime-probe/model.js';
import { workspaceBindingFailureResult } from './workspace-binding-error.js';
import { connectHostedRag, startHostedRagConnections, stopHostedRagConnections, type HostedSelection } from '../features/rag-hosted/index.js';

interface Job {
    id: string;
    kind: string;
    project_id?: string;
    lease: string;
    payload: ProjectLocalPayload & ConfigurationPayload & { folderName?: string; package?: Package; installSet?: InstallSet; bindingId?: string; instanceId?: string;
        mode?: WorkspaceBindingMode; preparation?: WorkspaceBindingPreparation; installations?: Package[]; workspaceFailureVersion?: 1;ragProtocol?:string;
        expectedBindingId?: string; expectedInstanceId?: string; consentManifest?: string;
        changePlanId?: string; changePlanRevision?: 1; expectedChangeDigest?: string;configurationRevisions?:ConfigurationRevision[];embedding?:HostedSelection;reindex?:true;ragReindexProtocol?:string };
}

/** Один worker на профиль и площадку; WS будит очередь, heartbeat страхует разрыв транспорта. */
export async function runWorker(): Promise<void> {
    if (!await waitForWorkerInstallation()) { return; }
    let credentials = await readState<Credentials>('credentials');
    if (!credentials) {
        return;
    }
    await fs.mkdir(stateDir(), { recursive: true, mode: 0o700 });
    const lock = path.join(stateDir(), 'worker.lock');
    try {
        await fs.writeFile(lock, String(process.pid), {
            flag: 'wx',
            mode: 0o600,
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
        const pid = Number(await readBoundedUtf8(lock, 4096));
        try {
            process.kill(pid, 0);
            return;
        } catch {
            await fs.rm(lock, { force: true });
        }
        try {
            await fs.writeFile(lock, String(process.pid), {
                flag: 'wx',
                mode: 0o600,
            });
        } catch {
            return;
        }
    }
    await writeState('worker-version', { pid: process.pid, version: BRIDGE_VERSION, buildId: await bridgeBuildId() });
    let running = false;
    let stopped = false;
    const socket = io(hub(), {
        transports: ['websocket', 'polling'],
        auth: { token: credentials.token },
        reconnection: true,
    });
    let heartbeatPending: Promise<void> | undefined;
    const heartbeat = (): Promise<void> => {
        if (stopped) { return Promise.resolve(); }
        if (heartbeatPending) { return heartbeatPending; }
        heartbeatPending = (async () => {
            const fresh = await readState<Credentials>('credentials');
            if (stopped) { return; }
            if (fresh && fresh.token !== credentials?.token) {
                credentials = fresh;
                socket.auth = { token: fresh.token };
                socket.disconnect().connect();
            }
            const report = await workspaceReport();
            if (!stopped) { await api('heartbeat', report); }
        })().finally(() => { heartbeatPending = undefined; });
        return heartbeatPending;
    };
    const drain = async (): Promise<void> => {
        if (running || stopped) {
            return;
        }
        running = true;
        try {
            await recoverPendingWorkspaceIdentity();
            await recoverFileJobs();
            await recoverRuntimePreparations();
            await recoverRagRestores();
            await startHostedRagConnections();
            await deliverCompletions();
            await heartbeat();
            while (!stopped) {
                const claimant = credentials!;
                const deviceId = claimant.deviceId;
                const current = await api<Job | null>('jobs/claim', undefined, claimant.token);
                if (!current) { break; }
                let lastPercent: number | undefined;
                let lastMessage = 'MCP выполняет задание';
                const update = (percent: number, message: string) => {
                    lastPercent = percent;
                    lastMessage = message;
                    return api(`jobs/${current.id}/progress`, {
                        lease: current.lease,
                        percent,
                        message,
                        state: 'running',
                    });
                };
                const authorize = async () => {
                    const result = await api(`jobs/${current.id}/authorize`, {
                        lease: current.lease,
                    });
                    if ([...CONFIGURATION_KINDS,...PROJECT_LOCAL_KINDS,'install', 'uninstall', 'inspect-installation','prepare-local-change','apply-local-change','open-local-change-report','open-local-recovery-folder','probe-runtime','sync-rag','restore-rag','open-rag-ui','connect-rag-model'].includes(current.kind) && current.payload.bindingId !== await projectBindingId(current.project_id || '')) {
                        throw new Error('Папка проекта изменилась после отправки запроса. Установка остановлена; проверьте привязку и повторите действие.');
                    }
                    return result;
                };
                const renew = setInterval(() => {
                    void api(`jobs/${current.id}/progress`, {
                        lease: current.lease,
                        percent: lastPercent,
                        message: lastMessage,
                        state: 'running',
                    }).catch(() => undefined);
                }, 30000);
                try {
                    await authorize();
                    let result: unknown;
                    if(CONFIGURATION_KINDS.includes(current.kind)){
                        result=await jobContext.run({id:current.id,lease:current.lease,deviceId},()=>
                            runMcpConfigurationJob(current,authorize,()=>api('configuration-authorize',{jobId:current.id})));
                    }else if (PROJECT_LOCAL_KINDS.includes(current.kind)) {
                        if(current.kind==='apply-adopt-installation'&&current.payload.package)await prepareJobMcpLaunchers(current.project_id??'',current.payload.package,current.payload.installSet,authorize);
                        result=await jobContext.run({id:current.id,lease:current.lease,deviceId},()=>runProjectLocalJob(current,authorize,update));
                    } else if (current.kind === 'choose-root') {
                        const selected = await chooseRoot();
                        result = { root: selected.root };
                    } else if (['bind-project','prepare-bind-project'].includes(current.kind)) {
                        const prepared = current.payload.preparation ?? await prepareProjectBinding({projectId:current.project_id || '',
                            folderName:current.payload.folderName || '',mode:current.payload.mode ?? 'new',
                            expectedBindingId:current.payload.expectedBindingId,expectedInstanceId:current.payload.expectedInstanceId});
                        if (current.kind === 'prepare-bind-project') { result = prepared; }
                        else {
                            result = await jobContext.run({id:current.id,lease:current.lease,deviceId},() =>
                                commitProjectBinding(prepared,async context => {
                                    await authorize();
                                    return verifyWorkspaceInstallations(context,current.payload.installations ?? [],authorize);
                                }));
                        }
                    } else if (current.kind === 'prepare-local-change' && current.payload.package) {
                        result = await prepareLocalChange(current.project_id || '',current.payload.package,current.payload.installSet,authorize);
                    } else if(current.kind==='open-rag-ui'&&current.payload.package){
                        result=await openRagUi({projectId:current.project_id||'',bindingId:current.payload.bindingId||'',instanceId:current.payload.instanceId||'',pkg:current.payload.package},async()=>{await authorize();});
                    } else if(current.kind==='connect-rag-model'&&current.payload.package&&current.payload.embedding){
                        await update(20,'Проверяем выбранную модель и доступ через мост.');
                        if((current.payload.reindex!==true)||current.payload.ragReindexProtocol!=='hosted-rag-reindex-v1')throw new Error('Обновите задание переиндексации до поддерживаемого формата.');
                        result=await jobContext.run({id:current.id,lease:current.lease,deviceId},async()=>{
                            const connected=await connectHostedRag(current.project_id||'',current.payload.bindingId||'',current.payload.instanceId||'',
                                current.payload.package!,current.payload.embedding!,async()=>{await authorize();},publication=>reindexHostedRag({projectId:current.project_id||'',bindingId:current.payload.bindingId||'',instanceId:current.payload.instanceId||'',pkg:current.payload.package!},publication,async()=>{await authorize();},update));
                            const synced=await runRagBridgeJob({kind:'sync-rag',projectId:current.project_id||'',bindingId:current.payload.bindingId||'',allowEmpty:true},async()=>{await authorize();},update);
                            if(!connected.reindex||synced.snapshotHash!==connected.reindex.snapshotHash)throw new Error('Серверная копия нового индекса не подтверждена. Повторите подключение.');
                            return {...connected,reindex:{...connected.reindex,serverSynced:true}};
                        });
                    } else if (current.kind === 'open-local-recovery-folder') {
                        await authorize(); await openLocalRecoveryFolder(current.project_id || '');
                        result = {projectId:current.project_id,bindingId:current.payload.bindingId,opened:true};
                    } else if (current.kind === 'open-local-change-report') {
                        await authorize();
                        await openLocalChangeReport({projectId:current.project_id || '',bindingId:current.payload.bindingId || '',instanceId:current.payload.instanceId || '',planId:current.payload.changePlanId || '',digest:current.payload.expectedChangeDigest || ''});
                        result = {projectId:current.project_id,bindingId:current.payload.bindingId,changePlanId:current.payload.changePlanId,digest:current.payload.expectedChangeDigest,opened:true};
                    } else if (current.kind === 'apply-local-change' && current.payload.package) {
                        await prepareJobMcpLaunchers(current.project_id??'',current.payload.package,current.payload.installSet,authorize);
                        result = await jobContext.run({id:current.id,lease:current.lease,deviceId},() =>
                            applyLocalChange(current.project_id || '',current.payload.package!,{planId:current.payload.changePlanId || '',
                                revision:current.payload.changePlanRevision ?? 1,digest:current.payload.expectedChangeDigest || '',
                                expectedBindingId:current.payload.bindingId || '',installSet:current.payload.installSet},authorize,update,
                                packages=>prepareJobRuntimeArtifacts(packages,authorize,(_percent,message)=>update(45,message),{repairCorrupt:true,intent:runtimePreparationCompletion(current,deviceId)})));
                    } else if (current.kind === 'probe-runtime' && current.payload.package) {
                        const pkg = current.payload.package;
                        result = await runRuntimeProbe({projectId:current.project_id || '',bindingId:current.payload.bindingId || '',
                            target:packageRef(pkg),frozenSet:current.payload.installSet ?? {schemaVersion:1,root:packageRef(pkg),packages:[pkg],manifest:pkg.manifest.sha256},
                            consentManifest:current.payload.consentManifest || '',...(current.payload.configurationRevisions?{configurationRevisions:current.payload.configurationRevisions}:{}),
                            openCode:await runtimeProbeEngine(),authorize:async () => { await authorize(); }});
                    } else if (current.kind === 'inspect-installation' && current.payload.package) {
                        const inspected = await inspectInstallation(current.project_id || '', current.payload.package);
                        assertInspectionIdentity(inspected, current.project_id || '', current.payload.bindingId, current.payload.package);
                        result = inspected;
                    } else if (
                        ['install','uninstall'].includes(current.kind) &&
                        current.payload.package
                    ) {
                        if (current.payload.installSet && current.kind === 'install') {
                            const root = current.payload.installSet.root;
                            const pkg = current.payload.package;
                            if (root.kind !== pkg.plugin.kind || root.id !== pkg.plugin.id || root.version !== pkg.plugin.version
                                || root.manifest !== pkg.manifest.sha256) { throw new Error('Корневой пакет не совпадает с набором установки.'); }
                        }
                        if(current.kind==='install')await jobContext.run({id:current.id,lease:current.lease,deviceId},()=>
                            prepareJobRuntimeArtifacts(current.payload.installSet?.packages??[current.payload.package!],authorize,update,{intent:runtimePreparationCompletion(current,deviceId)}));
                        if(current.kind==='install')await prepareJobMcpLaunchers(current.project_id??'',current.payload.package,current.payload.installSet,authorize);
                        result = await jobContext.run({ id: current.id, lease: current.lease, deviceId }, () =>
                            current.kind === 'install' && current.payload.installSet
                                ? installSet(current.project_id || '', current.payload.installSet, authorize, update)
                                : (current.kind === 'install' ? install : uninstall)(
                                    current.project_id || '', current.payload.package!, authorize, update,
                                ));
                    } else if (['restore-rag','sync-rag'].includes(current.kind)) {
                        if(current.payload.ragProtocol!=='project-rag-generations-v1')throw new Error('Задание создано до обновления формата RAG. Запустите новую синхронизацию знаний в Нейроцентре.');
                        if(current.kind==='restore-rag'){await authorize();await closeOwnRagUi(current.project_id||'');await authorize();}
                        result = await jobContext.run({id:current.id,lease:current.lease,deviceId},()=>runRagBridgeJob({
                            kind:current.kind as 'restore-rag'|'sync-rag',projectId:current.project_id || '',bindingId:current.payload.bindingId || '',
                        },async()=>{await authorize();},update));
                    } else {
                        throw new Error('Неизвестное задание MCP.');
                    }
                    if(current.kind==='install'){
                        for(const member of current.payload.installSet?.packages??(current.payload.package?[current.payload.package]:[])){
                            if(member.plugin.kind!=='mcp')continue;
                            try{
                                if(!localRagUi(member))continue;
                                await update(95,'Проверяем запуск opencode-rag mcp.');
                                await probeInstalledRagMcp(current.project_id||'',current.payload.bindingId||'',member,async()=>{await authorize();});
                                process.stderr.write('neurocenter bridge: подключение OpenCodeRAG MCP проверено; модель и индекс не проверялись.\n');
                            }catch{process.stderr.write('neurocenter bridge: файлы установлены; проверка запуска OpenCodeRAG MCP не завершена. Проверьте подключение отдельно.\n');}
                        }
                    }
                    clearInterval(renew);
                    const requirements=current.payload.package?.config?.extra?.requirements;
                    const hasRequirements=!!(requirements?.mcp?.length||requirements?.plugins?.length);
                    await saveCompletion({
                        id: current.id,
                        deviceId,
                        lease: current.lease,
                        state: 'succeeded',
                        message:
                            CONFIGURATION_KINDS.includes(current.kind)?'Действие настройки MCP завершено. Значения остались на компьютере.':PROJECT_LOCAL_KINDS.includes(current.kind) ? 'Локальное действие завершено.' : current.kind === 'install'
                                ? current.payload.installSet ? 'Набор инструментов установлен; запуск в OpenCode ещё не проверен.' : hasRequirements ? 'Файлы установлены; проверьте настройку внешних подключений.' : 'Файлы установлены'
                                : current.kind === 'inspect-installation' ? 'Проверка файлов завершена; запуск инструмента не проверялся.'
                                : current.kind === 'prepare-local-change' ? 'Сравнение подготовлено. Проверьте изменения перед восстановлением.'
                                : current.kind === 'open-local-change-report' ? 'Полное сравнение открыто на подключённом компьютере.'
                                : current.kind === 'open-rag-ui' ? 'Локальный интерфейс готов; отдельное окно запрошено на компьютере.'
                                : current.kind === 'connect-rag-model' ? 'Подключение модели и локальный индекс проверены.'
                                : current.kind === 'open-local-recovery-folder' ? 'Резервные копии открыты на подключённом компьютере.'
                                : ['apply-local-change',...PROJECT_LOCAL_APPLIES].includes(current.kind) ? 'Одобренные файлы восстановлены; локальный вариант сохранён.'
                                : current.kind === 'probe-runtime' ? 'Проверка запуска OpenCode завершена.'
                                : current.kind === 'prepare-bind-project' ? 'Папка проверена. Подтвердите действие в мастере.'
                                : current.kind==='uninstall'?'Файлы и подключение удалены'
                                : current.kind === 'bind-project'
                                  ? 'Папка связана с проектом'
                                  : current.kind === 'choose-root'
                                    ? 'Папка проектов выбрана'
                                    : 'Синхронизация базы знаний завершена',
                        result: result as Record<string, unknown>,
                    });
                    if(current.kind==='connect-rag-model'&&current.payload.reindex)await finalizeRagReindex(await projectFolder(current.project_id||''),current.id);
                    await deliverCompletions();
                } catch (error) {
                    clearInterval(renew);
                    if(current.kind==='connect-rag-model'&&current.payload.reindex){const root=await projectFolder(current.project_id||'');releaseRagReindex(root);await recoverRagRestore(root);}
                    // Фиксация файлов и доставка отчёта независимы: сеть не отменяет установленный пакет.
                    if (current.kind !== 'inspect-installation') { await recoverFileJobs(); }
                    if (current.kind === 'bind-project') { await recoverPendingWorkspaceIdentity(); }
                    if (!(await pendingCompletions()).some(item => item.id === current.id)) {
                        if ((error as { localChangesCommitted?: boolean }).localChangesCommitted) { throw error; }
                        const pkg = current.payload.package;
                        // После восстановления отсутствие квитанции означает отказ до файловой транзакции.
                        const result = current.kind === 'probe-runtime' && pkg ? {
                            schemaVersion:1,projectId:current.project_id,bindingId:current.payload.bindingId,
                            assetId:pkg.plugin.id,assetKind:pkg.plugin.kind,version:pkg.plugin.version,manifest:pkg.manifest.sha256,
                            approvalManifest:current.payload.consentManifest,checkedAt:new Date().toISOString(),engineVersion:'1.14.48',engineSha256:'',
                            status:'not_checked',code:'authorization-denied',counts:{packages:0,files:0,skills:0,mcp:0,tools:0,resources:0,prompts:0,pluginsInitialized:0},
                            ...(current.payload.configurationRevisions?{configurationRevisions:current.payload.configurationRevisions}:{}),
                        } : current.kind === 'inspect-installation' && pkg ? {
                            schemaVersion: 1, projectId: current.project_id, bindingId: current.payload.bindingId,
                            assetId: pkg.plugin.id, assetKind: pkg.plugin.kind, version: pkg.plugin.version, manifest: pkg.manifest.sha256,
                            checkedAt: new Date().toISOString(), readiness: 'unverified', state: 'checked', status: 'unknown', issues: ['inspection-failed'],
                        } : ['install','uninstall','apply-local-change',...PROJECT_LOCAL_APPLIES].includes(current.kind) && pkg ? {
                            projectId: current.project_id, assetId: pkg.plugin.id, version: pkg.plugin.version,
                            manifest: current.payload.installSet?.manifest ?? pkg.manifest.sha256,
                            ...(current.payload.installSet ? { packages: sortedRefs(current.payload.installSet.packages) } : {}),
                            bindingId: current.payload.bindingId, unchanged: true,
                            ...(['apply-local-change',...PROJECT_LOCAL_APPLIES].includes(current.kind) ? {changePlanId:current.payload.changePlanId,digest:current.payload.expectedChangeDigest} : {}),
                        } : workspaceBindingFailureResult(current.kind, current.payload.workspaceFailureVersion, error);
                        await saveCompletion({ id: current.id, lease: current.lease, deviceId,
                            state: 'failed', result, message: [...CONFIGURATION_KINDS,...PROJECT_LOCAL_KINDS,'inspect-installation','prepare-bind-project','bind-project','prepare-local-change','apply-local-change','open-local-change-report','open-local-recovery-folder','probe-runtime','open-rag-ui','connect-rag-model'].includes(current.kind)
                                ? 'Действие не выполнено. Проверьте актуальную папку и доступ.' : (error as Error).message.slice(0, 1500) });
                    }
                    await deliverCompletions();
                }
                await heartbeat();
            }
        } catch (error) {
            process.stderr.write(
                'neurocenter bridge: ' + (error as Error).message + '\n',
            );
        } finally {
            running = false;
        }
    };
    const timer = setInterval(() => {
        // Долгое задание сохраняет очередь последовательной, но не приостанавливает присутствие компьютера.
        if (running) {
            void heartbeat().catch(error => process.stderr.write('neurocenter bridge: ' + (error as Error).message + '\n'));
        } else { void drain(); }
    }, 15000);
    socket.on('connect', () => {
        void drain();
    });
    socket.on('bridge:work', () => {
        void drain();
    });
    const stop = (): void => {
        stopped = true;
        clearInterval(timer);
        socket.disconnect();
        void Promise.all([closeRagUis(),stopHostedRagConnections()]).then(()=>readBoundedUtf8(lock, 4096))
            .then((value) =>
                value === String(process.pid)
                    ? fs.rm(lock, { force: true })
                    : undefined,
            )
            .finally(() => process.exit(0));
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    await drain();
}
