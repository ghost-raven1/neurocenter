import {completeLearningMemory} from '../learning-memory-sync/completion';
import {completeLearningQuirks} from '../learning-quirks/completion';
import {PROJECT_CONFIGURATION_JOB,normalizeProjectConfigurationReport} from '../../../shared/project-configuration.cjs';
import {completeDeviceCodex} from '../models/device-codex-completion';
import {completeRuntimeCachePolicy} from './runtime-cache-jobs';
import {PROJECT_AGENTS_JOB,PROJECT_AGENTS_NOTE} from '../../../shared/project-agents.cjs';
import {assertAgentCompletionAccess} from '../agents/agent-completion-access';
import {assertAgentConfigurationResult} from '../agents/agent-jobs';
import {assertSnapshotCompletion} from './project-snapshot-completion';
import {SNAPSHOT_JOB_KIND} from './project-snapshot-jobs';
import { PROJECT_LOCAL_KINDS, LOCAL_PREPARATIONS, LOCAL_APPLIES, localPurpose } from './project-local-actions';
import { assertProjectInventory, assertLocalVariants } from './project-local-reports';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { assertWorkspacePreparation, saveWorkspaceEvent } from './workspace-jobs';
import { saveLocalChangePlan } from './local-change-plan';
import { assertRuntimeProbe } from './runtime-probe';
import type { Pool } from 'pg';
import { recordDeviceOperation, notifyDeviceOperations } from './device-operations';
import {installationRefs,verifyInstallationSet,type IInstallationSet} from './installation-set';
import { assertInstallationInspection } from './installation-inspection';
import { CONFIGURATION_KINDS, assertConfigurationReport } from './mcp-config-reports';
import type { IPackage } from '../catalog/bundle-package';
import { assertRagJobResult, isLegacyRagJob, RAG_UPGRADE_MESSAGE, RAG_UPGRADE_RESULT } from './rag-job-result';
import { RAG_JOB_KINDS } from './rag-job-binding';
import { workspaceFailureMessage } from './workspace-failure';
import {completeHostedRagGrant} from './hosted-rag-grants';
import { HOSTED_RAG_KIND, assertHostedRagResult } from './hosted-rag-jobs';
import { validModelScan } from '../../../shared/opencode-model-scan.cjs';
import {OPENCODE_PROVIDER_JOBS,normalizeProviderReport} from '../../../shared/opencode-providers.cjs';
import {continueRagInstallationInspection} from './rag-install-inspection';

export interface DeviceCompletion {
    lease: string;
    state: 'succeeded' | 'failed';
    message: string;
    result: Record<string, unknown>;
}
interface Job {
    id: string; device_id: string; email: string; role:string; project_id: string | null; kind: string; state: string;
    percent: number | null; lease_until: Date; result: unknown;
    payload: Record<string, unknown> & { bindingId?: string; package?: { plugin: { id: string; kind?: string; version: number }; manifest: { sha256: string } }; installSet?: IInstallationSet };
}

/** Подтверждение идемпотентно и атомарно с журналом; истёкшая аренда не требует повторной записи файлов. */
export async function completeDeviceJob(pool: Pool, deviceId: string, id: string, input: DeviceCompletion) {
    if (!input || !['succeeded', 'failed'].includes(input.state) || typeof input.lease !== 'string'
        || typeof input.message !== 'string' || input.message.length > 1500
        || !input.result || typeof input.result !== 'object' || Array.isArray(input.result)
        || Buffer.byteLength(JSON.stringify(input.result)) > 512 * 1024) {
        throw new BadRequestException('Некорректное подтверждение задания.');
    }
    const client = await pool.connect();
    let discard = false;
    try {
        await client.query('BEGIN');
        const { rows } = await client.query<Job>(
            'SELECT * FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND lease=$3 FOR UPDATE',
            [id, deviceId, input.lease],
        );
        const job = rows[0];
        if(job&&['install','uninstall','apply-local-change','apply-adopt-installation'].includes(job.kind))await client.query('SELECT id FROM bridge_devices WHERE id=$1 FOR UPDATE',[deviceId]);
        if (!job) { throw new ConflictException('Аренда задания не соответствует подключению.'); }
        const codex=await completeDeviceCodex(client,job,input);
        if(codex){await client.query('COMMIT');if(!codex.repeated)await notifyDeviceOperations();return codex;}
        const cache=await completeRuntimeCachePolicy(client,job,input);
        if(cache){await client.query('COMMIT');if(!cache.repeated)await notifyDeviceOperations();return cache;}
        const memory=await completeLearningMemory(client,job,input);
        if(memory){await client.query('COMMIT');if(!memory.repeated)await notifyDeviceOperations();return memory;}
        const quirks=await completeLearningQuirks(client,job,input);
        if(quirks){await client.query('COMMIT');if(!quirks.repeated)await notifyDeviceOperations();return quirks;}
        // Потерянный ACK уже принятого legacy-результата не превращается в повторную запись индекса.
        if (RAG_JOB_KINDS.includes(job.kind) && job.state===input.state && isDeepStrictEqual(job.result ?? {},input.result)) {
            await client.query('COMMIT'); return {ok:true,repeated:true};
        }
        // Старый непроверенный успех получает ACK как отказ; очередь других действий продолжает работать.
        if (isLegacyRagJob(job) && input.state==='succeeded' && input.result.projectId===job.project_id && input.result.ok===true
            && (['running','reconciling'].includes(job.state) || job.state==='failed' && isDeepStrictEqual(job.result,RAG_UPGRADE_RESULT))) {
            input = {...input,state:'failed',message:RAG_UPGRADE_MESSAGE,result:RAG_UPGRADE_RESULT};
        }
        await assertSnapshotCompletion(client,job,input.result,input.state==='failed');
        assertRagJobResult(job,input.result,input.state==='failed');
        assertAgentConfigurationResult(job,input.result,input.state==='failed');
        if(job.kind===PROJECT_CONFIGURATION_JOB){try{normalizeProjectConfigurationReport(input.result,job.payload.descriptor,input.state==='failed');}catch{throw new ConflictException('Мастер не передаёт локальные файлы, адреса и значения на сервер.');}}
        if(CONFIGURATION_KINDS.includes(job.kind))assertConfigurationReport(job.kind,input.result,
            {...job.payload,package:job.payload.package as IPackage,projectId:job.project_id},input.state==='failed');
        if(OPENCODE_PROVIDER_JOBS.includes(job.kind as never)){
            try{normalizeProviderReport(job.kind,input.result,job.payload.descriptor,input.state==='failed',job.payload.preparationId as string|undefined);}
            catch{throw new ConflictException('Отчёт провайдера содержит неподдерживаемые данные или другой контекст.');}
        }
        if(job.kind==='scan-opencode-models'&&(input.state==='failed'?Object.keys(input.result).length>0:!validModelScan(input.result,job.payload.scope==='global'?{scope:'global',deviceId:job.device_id}:{scope:'project',projectId:job.project_id,bindingId:job.payload.bindingId,instanceId:job.payload.instanceId})))throw new ConflictException('Отчёт моделей содержит неподдерживаемые данные или относится к другому источнику.');
        if (![PROJECT_CONFIGURATION_JOB,...LOCAL_PREPARATIONS,'scan-opencode-models','scan-project-inventory','list-local-variants'].includes(job.kind) && Buffer.byteLength(JSON.stringify(input.result)) > 10000) {
            throw new BadRequestException('Результат задания превышает допустимый размер.');
        }
        if (['scan-project-inventory','list-local-variants'].includes(job.kind)) {
            if(input.state==='failed') { if(Object.keys(input.result).length)throw new ConflictException('Ошибка чтения не передаёт локальные данные.'); }
            else if(job.kind==='scan-project-inventory')assertProjectInventory(input.result,{...job.payload,projectId:job.project_id});
            else assertLocalVariants(input.result,{...job.payload,projectId:job.project_id});
        }
        if (job.kind === 'inspect-installation') {
            assertInstallationInspection(input.result,{projectId:job.project_id,bindingId:job.payload.bindingId,package:job.payload.package},input.state === 'failed');
        }
        if (job.kind === 'probe-runtime') {
            assertRuntimeProbe(input.result,{...job.payload,projectId:job.project_id,consentManifest:job.payload.consentManifest as string},input.state === 'failed');
        }
        if (job.kind === 'open-local-change-report') {
            const allowed = ['projectId','bindingId','changePlanId','digest','opened'];
            if (input.state === 'failed' ? Object.keys(input.result).length > 0
                : Object.keys(input.result).length !== allowed.length || Object.keys(input.result).some(key => !allowed.includes(key))
                    || input.result.projectId !== job.project_id || input.result.bindingId !== job.payload.bindingId
                    || input.result.changePlanId !== job.payload.changePlanId || input.result.digest !== job.payload.expectedChangeDigest || input.result.opened !== true) {
                throw new ConflictException('Открытие сравнения не должно передавать локальный отчёт на сервер.');
            }
        }
        if(job.kind==='open-rag-ui'){
            const fields=['opened','reused','note'];
            if(input.state==='failed'?Object.keys(input.result).length!==0:Object.keys(input.result).length!==fields.length
                ||Object.keys(input.result).some(key=>!fields.includes(key))||input.result.opened!==true||typeof input.result.reused!=='boolean'
                ||input.result.note!=='Локальный интерфейс готов; система приняла запрос на отдельное окно браузера.')
                throw new ConflictException('Открытие интерфейса не передаёт локальные адреса, секреты и пути.');
        }
        if (job.kind === HOSTED_RAG_KIND) assertHostedRagResult(input.result,job.payload,input.state==='failed');
        if (job.kind === 'open-local-recovery-folder') {
            const fields=['projectId','bindingId','opened'];
            if (input.state === 'failed' ? Object.keys(input.result).length !== 0 : Object.keys(input.result).length !== fields.length
                || Object.keys(input.result).some(key=>!fields.includes(key)) || input.result.projectId !== job.project_id
                || input.result.bindingId !== job.payload.bindingId || input.result.opened !== true) { throw new ConflictException('Открытие резервных копий не передаёт локальные данные.'); }
        }
        if (['install','uninstall',...LOCAL_APPLIES].includes(job.kind)) {
            const pkg = job.payload.package;
            const set = job.payload.installSet;
            if (!pkg || !pkg.plugin || !pkg.manifest || input.result.projectId !== job.project_id || input.result.assetId !== pkg.plugin.id
                || input.result.version !== pkg.plugin.version || input.result.manifest !== (set?.manifest ?? pkg.manifest.sha256)
                || (set && (!verifyInstallationSet(set) || !isDeepStrictEqual(input.result.packages,installationRefs(set.packages))))
                || (job.payload.bindingId && input.result.bindingId !== job.payload.bindingId)
                || (input.state === 'failed' && input.result.rolledBack !== true && input.result.unchanged !== true)) {
                throw new ConflictException('Для завершения операции нужна исходная квитанция или подтверждённый откат.');
            }
            if (LOCAL_APPLIES.includes(job.kind) && (input.result.changePlanId !== job.payload.changePlanId
                || input.result.digest !== job.payload.expectedChangeDigest)) { throw new ConflictException('Результат не соответствует применяемому плану изменений.'); }
            if (LOCAL_APPLIES.includes(job.kind)) {
                const allowed = ['projectId','assetId','version','manifest','bindingId','changePlanId','digest','files','changed','packages','readiness','rolledBack','unchanged'];
                if (Object.keys(input.result).some(key => !allowed.includes(key))
                    || (input.result.files !== undefined && (!Number.isSafeInteger(input.result.files) || Number(input.result.files) < 0 || Number(input.result.files) > 200))
                    || (input.result.changed !== undefined && typeof input.result.changed !== 'boolean')
                    || (input.result.readiness !== undefined && input.result.readiness !== 'unverified')
                    || ['rolledBack','unchanged'].some(key => input.result[key] !== undefined && typeof input.result[key] !== 'boolean')
                    || (!set && input.result.packages !== undefined)
                    || (input.state === 'succeeded' && (input.result.readiness !== 'unverified' || typeof input.result.changed !== 'boolean'
                        || !Number.isSafeInteger(input.result.files) || Number(input.result.files) < 0 || Number(input.result.files) > 200))) {
                    throw new ConflictException('Результат восстановления содержит неподдерживаемые данные. Локальные пути и содержимое передавать запрещено.');
                }
            }
        }
        const known = [PROJECT_AGENTS_JOB,SNAPSHOT_JOB_KIND,...CONFIGURATION_KINDS,...OPENCODE_PROVIDER_JOBS,...PROJECT_LOCAL_KINDS,HOSTED_RAG_KIND,'choose-root', 'bind-project', 'prepare-bind-project', 'prepare-local-change','open-local-change-report','open-local-recovery-folder', 'probe-runtime','open-rag-ui','sync-rag', 'restore-rag','inspect-installation'].includes(job.kind);
        const matching = job.kind === 'scan-opencode-models' ? job.payload.scope==='global'?job.project_id===null&&input.result.scope==='global'&&input.result.deviceId===job.device_id:input.result.scope==='project'&&input.result.projectId===job.project_id : job.kind === PROJECT_AGENTS_JOB ? input.result.readiness==='configured' : job.kind === SNAPSHOT_JOB_KIND ? input.result.status==='UPLOADED' : job.kind === HOSTED_RAG_KIND ? input.result.status === 'connected' : job.kind === 'open-rag-ui' ? input.result.opened === true : job.kind === 'choose-root'
            ? typeof input.result.root === 'string' && input.result.root.length > 0 && input.result.root.length <= 4096
            : input.result.projectId === job.project_id && ([...CONFIGURATION_KINDS,...OPENCODE_PROVIDER_JOBS,...PROJECT_LOCAL_KINDS,'bind-project','prepare-bind-project','prepare-local-change','open-local-change-report','open-local-recovery-folder','probe-runtime','inspect-installation'].includes(job.kind) || input.result.ok === true);
        // Действующая аренда подтверждает исполнителя, но не принадлежность результата исходному проекту.
        if (known && input.state === 'succeeded' && !matching) {
            throw new ConflictException('Результат не соответствует исходному заданию выбора папки или действия с проектом.');
        }
        if (['succeeded', 'failed'].includes(job.state)) {
            if (job.state !== input.state || !isDeepStrictEqual(job.result ?? {}, input.result)) {
                throw new ConflictException('Задание уже завершено с другим результатом.');
            }
            await client.query('COMMIT');
            return { ok: true, repeated: true };
        }
        if(job.kind===PROJECT_AGENTS_JOB&&input.state==='succeeded')await assertAgentCompletionAccess(client,job);
        if (job.kind === 'prepare-bind-project' && input.state === 'succeeded') {
            assertWorkspacePreparation(input.result,{projectId:job.project_id ?? undefined,folderName:job.payload.folderName as string,mode:job.payload.mode});
        }
        const workspaceMessage = ['prepare-bind-project','bind-project'].includes(job.kind)
            ? input.state === 'failed' ? workspaceFailureMessage(input.result, job.payload.workspaceFailureVersion)
                : job.kind === 'prepare-bind-project' ? 'Папка проверена. Подтвердите действие в мастере.' : 'Папка проекта связана.'
            : undefined;
        if (LOCAL_PREPARATIONS.includes(job.kind) && input.state === 'failed' && Object.keys(input.result).length > 0) {
            throw new ConflictException('Ошибка сравнения не передаёт локальные файлы и настройки.');
        }
        if (!['running', 'reconciling'].includes(job.state)) {
            throw new ConflictException('Отменённое или не начатое задание нельзя подтвердить.');
        }
        if (!['install','uninstall',...LOCAL_APPLIES].includes(job.kind) && (job.state === 'reconciling' || new Date(job.lease_until).getTime() <= Date.now())) {
            if (!known) {
                throw new ConflictException('Для сверки нужен результат исходного задания выбора папки или синхронизации проекта.');
            }
        }
        const percent = input.state === 'succeeded' ? 100 : job.percent ?? 0;
        if (job.kind === 'bind-project' && job.payload.mode && input.state === 'succeeded') {
            await saveWorkspaceEvent(client,job,input.result);
        }
        if (LOCAL_PREPARATIONS.includes(job.kind) && input.state === 'succeeded') {
            await saveLocalChangePlan(client,{...job,payload:{...job.payload,projectId:job.project_id,instanceId:job.payload.instanceId as string}},input.result,localPurpose(job.kind),(job.payload.candidateId ?? job.payload.recoveryId) as string|undefined);
        }
        if (LOCAL_APPLIES.includes(job.kind) && input.state === 'succeeded') {
            const saved = await client.query(`UPDATE bridge_local_change_plans SET applied_job_id=$2
                WHERE id=$1 AND digest=$3 AND purpose=$4 AND (applied_job_id IS NULL OR applied_job_id=$2) RETURNING id`,[job.payload.changePlanId,job.id,job.payload.expectedChangeDigest,localPurpose(job.kind)]);
            if (!saved.rowCount) { throw new ConflictException('План изменений уже применён другим заданием.'); }
        }
        const configurationMessage=CONFIGURATION_KINDS.includes(job.kind)?input.state==='failed'?'Настройка недоступна. Проверьте компьютер, папку и одобрение.'
            :job.kind==='prepare-mcp-configuration'?'Настройка подготовлена. Откройте локальный мастер на выбранном компьютере.'
            :job.kind==='open-mcp-configuration'?'Мастер открыт на компьютере. После сохранения обновите статус настройки.'
            :input.result.ready?'Обязательные параметры MCP заданы; запуск ещё не проверен.':'MCP требует локальной настройки.':undefined;
        const projectMessage = PROJECT_LOCAL_KINDS.includes(job.kind) ? input.state==='failed' ? 'Действие не выполнено. Локальные данные сохранены.'
            : job.kind==='scan-opencode-models' ? 'Метаданные моделей OpenCode получены. Ключи остались на компьютере.'
            : job.kind==='scan-project-inventory' ? 'Инвентаризация проекта завершена.'
            : job.kind==='list-local-variants' ? 'Список локальных вариантов получен.'
            : job.kind==='apply-adopt-installation' ? 'Инструмент принят под управление; исходные файлы сохранены.'
            : job.kind==='apply-local-restore' ? 'Локальные правки возвращены; прежнее состояние сохранено.'
            : 'План подготовлен. Проверьте изменения перед подтверждением.' : undefined;
        const hostedMessage=job.kind===HOSTED_RAG_KIND?(input.state==='failed'?'Подключение модели не подтверждено. Прежний локальный индекс сохранён; проверьте состояние на компьютере.':job.payload.reindex?'Модель подключена, локальный индекс перестроен и синхронизирован с сервером.':'Модель подключена к установленному OpenCodeRAG.'):undefined;
        const snapshotMessage=job.kind===SNAPSHOT_JOB_KIND?(input.state==='succeeded'?'Все блоки снимка приняты сервером. Проверка LanceDB выполняется отдельно.':'Передача снимка прервалась. Создайте новый снимок; локальная база не изменялась.'):undefined;
        const agentMessage=job.kind===PROJECT_AGENTS_JOB?(input.state==='succeeded'?PROJECT_AGENTS_NOTE:input.result.code==='OPENCODE_AGENT_MODEL_SETUP_REQUIRED'?'Настройте модель в OpenCode выбранного компьютера и повторите применение. Прежние агенты сохранены.':'Настройка агентов не применена. Проверьте компьютер, папку и локальные изменения.'):undefined;
        const providerMessage=OPENCODE_PROVIDER_JOBS.includes(job.kind as never)?input.state==='failed'?'Настройка провайдера не подтверждена. Проверьте компьютер и доступ к проекту.'
            :job.kind==='prepare-opencode-provider'?'Настройка подготовлена. Откройте мастер на выбранном компьютере.'
            :job.kind==='open-opencode-provider'?'Мастер открыт на компьютере. После сохранения обновите статус.'
            :input.result.ready?'Локальный провайдер настроен; запрос к модели не проверялся.':'Локальному провайдеру требуется настройка.':undefined;
        const automaticInspection=await continueRagInstallationInspection(client,job,input.state);
        const localConfigurationMessage=job.kind===PROJECT_CONFIGURATION_JOB?(input.state==='succeeded'?'Мастер открыт на компьютере. Просмотрите и подтвердите изменения в локальной форме.':'Мастер не открыт. Проверьте права администратора проекта, флаг и привязку папки.'):undefined;
        const message = localConfigurationMessage ?? providerMessage ?? agentMessage ?? snapshotMessage ?? hostedMessage ?? configurationMessage ?? projectMessage ?? workspaceMessage ?? (job.kind === 'inspect-installation'
            ? input.state === 'failed' ? 'Проверка файлов не выполнена.' : input.result.state === 'busy' ? 'Проверка отложена: проект занят.' : 'Сверка файлов завершена; запуск в OpenCode не проверен.'
            : job.kind === 'probe-runtime' ? 'Проверка запуска OpenCode завершена. Результат доступен в установке.'
            : LOCAL_APPLIES.includes(job.kind) ? input.state === 'failed' ? 'Восстановление не выполнено. Локальный вариант сохранён.' : 'Одобренные файлы восстановлены. Локальный вариант сохранён на компьютере.'
            : job.kind === 'open-rag-ui' ? input.state === 'failed' ? 'Интерфейс OpenCodeRAG не открыт. Проверьте папку, обновление инструмента и браузер на компьютере.' : 'Локальный интерфейс готов; отдельное окно запрошено на компьютере.'
            : job.kind === HOSTED_RAG_KIND ? input.state === 'failed' ? 'Модель не подключена. Проверьте хостинг, выбранную модель и версию OpenCodeRAG.' : 'Подключение модели проверено. Перезапустите OpenCode; индекс проверяется отдельно.'
            : job.kind === 'open-local-change-report' ? input.state === 'failed' ? 'Сравнение не открыто. Проверьте подключённый компьютер.' : 'Полное сравнение открыто только на подключённом компьютере.'
            : job.kind === 'open-local-recovery-folder' ? input.state === 'failed' ? 'Папка резервных копий не открыта.' : 'Резервные копии открыты на подключённом компьютере.'
            : LOCAL_PREPARATIONS.includes(job.kind) ? input.state === 'failed' ? 'Сравнение не выполнено. Локальные файлы сохранены.' : 'План изменений подготовлен. Проверьте его перед применением.'
            : job.kind==='install'&&automaticInspection?'OpenCodeRAG установлен. Проверяем файлы; модель и индекс ещё не проверены.':input.message);
        await client.query(
            'UPDATE bridge_jobs SET state=$2,percent=$3,message=$4,result=$5,updated_at=now() WHERE id=$1',
            [id, input.state, percent, message, input.result],
        );
        if(job.kind===HOSTED_RAG_KIND&&input.state==='succeeded')await completeHostedRagGrant(client,job.id);
        await recordDeviceOperation(client, job, input.state.toUpperCase(), percent, message);
        await client.query('COMMIT');
    } catch (error) {
        // Неподтверждённый откат не должен попасть в транзакцию следующего заёмщика пула.
        await client.query('ROLLBACK').catch(() => { discard = true; });
        throw error;
    } finally { client.release(discard); }
    await notifyDeviceOperations();
    return { ok: true, repeated: false };
}
