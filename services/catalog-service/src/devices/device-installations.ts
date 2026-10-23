import {supportsLearningQuirks} from '../../../shared/project-learning-quirks.cjs';
import {memoryRecipeSupported} from '../../../shared/project-learning-memory-sync.cjs';
import type {PoolClient} from 'pg';
import {localRagUi} from '../../../shared/rag-ui-contract.cjs';
import {
    BadRequestException,
    ConflictException,
    Injectable,
} from '@nestjs/common';
import type { IAccessActor } from '../access/access.model';
import { projectLevel } from '../access/access.model';
import { verifyPackage, type IPackage } from '../catalog/bundle-package';
import { DeviceStore } from './device-store';
import { assertInstallationInspection, type InstallationInspection } from './installation-inspection';
import { assertRuntimeProbe, type RuntimeProbeResult } from './runtime-probe';
import { verifyInstallationSet, packageDependencies, type IInstallationSet } from './installation-set';
import { installedGraph } from './installed-graph';
import { configurationSchemaDigest } from './mcp-config-reports';
import { readConfigurationState } from './mcp-config-status';
import { supportsHostedRag } from './hosted-rag-jobs';

const latest = `WITH installed_events AS (
    SELECT j.*,member AS installed_package,j.payload->>'bindingId' AS installed_binding,
        CASE WHEN j.kind IN ('apply-local-change','apply-adopt-installation') THEN 'install' ELSE j.kind END AS installed_action FROM bridge_jobs j
    CROSS JOIN LATERAL jsonb_array_elements(CASE
        WHEN j.kind IN ('install','apply-local-change','apply-adopt-installation') AND jsonb_typeof(j.payload->'installSet'->'packages')='array' THEN j.payload->'installSet'->'packages'
        ELSE jsonb_build_array(j.payload->'package') END) member
    WHERE email=$1 AND state='succeeded' AND kind IN ('install','uninstall','apply-local-change','apply-adopt-installation')
    UNION ALL
    SELECT j.*,member AS installed_package,e.binding_id AS installed_binding,'install' AS installed_action
    FROM bridge_instance_events e JOIN bridge_jobs j ON j.id=e.id
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.installations)='array' THEN e.installations ELSE '[]'::jsonb END) member
    WHERE e.email=$1 AND j.state='succeeded'
), latest AS (
    SELECT DISTINCT ON (device_id,project_id,installed_binding,installed_package->'plugin'->>'kind',installed_package->'plugin'->>'id') *
    FROM installed_events
    ORDER BY device_id,project_id,installed_binding,installed_package->'plugin'->>'kind',installed_package->'plugin'->>'id',COALESCE(started_at,created_at) DESC,id DESC
)`;
interface InstallationRow {
    deviceId: string; projectId: string; assetId: string; assetKind: string; version: number;
    name: string; manifest: string; updatedAt: string; bindingId: string | null;
    bindings: Array<{ projectId: string; valid?: boolean; bindingId?: string; folderName?: string;instanceId?:string }> | null;
    installedConfig?:IPackage['config'];
    inspection?: Record<string, unknown> | null;
    runtime?: Record<string, unknown> | null;
    runtimeObservedAt?:string;
    runtimeSource?: {bindingId?:string;consentManifest?:string;package?:IPackage;installSet?:{packages:IPackage[]}} | null;
}
interface InstallationInput {
    deviceId: string;
    projectId?: string;
    assetId?: string;
    assetKind?: string;
    expectedManifest?: string;
    bindingId?: string;
}

/** История успешных команд сохраняет установки, даже когда инструмент убран из каталога проекта. */
@Injectable()
export class DeviceInstallations {
    constructor(private readonly store: DeviceStore) {}
    /** Для миграции берём замороженную историю выбранной привязки, а не текущую версию магазина. */
    async workspacePackages(email: string, deviceId: string, projectId: string, bindingId?: string): Promise<IPackage[]> {
        const { rows } = await this.store.pool.query<{ kind: string; package: IPackage }>(`${latest}
            SELECT installed_action AS kind,installed_package AS package FROM latest WHERE device_id=$2 AND project_id=$3
                AND installed_binding IS NOT DISTINCT FROM $4 ORDER BY installed_package->'plugin'->>'kind',installed_package->'plugin'->>'id'`,
        [email, deviceId, projectId, bindingId ?? null]);
        const packages = rows.filter(row => row.kind === 'install').map(row => row.package);
        if (packages.length > 20 || Buffer.byteLength(JSON.stringify(packages)) > 24 * 1024 * 1024
            || packages.some(pkg => { try { return !verifyPackage(pkg); } catch { return true; } })) {
            throw new ConflictException('История установки повреждена или превышает лимит. Нужна ручная сверка папки.');
        }
        return packages;
    }
    async list(actor: IAccessActor) {
        const claims = await this.store.access.claims(actor.email);
        const projects = claims.projects
            .filter(
                (project) =>
                    projectLevel(claims, actor.activeRole, project.projectId) >
                    0,
            )
            .map((project) => project.projectId);
        const rows = (
            await this.store.pool.query<InstallationRow>(
                `${latest}
            SELECT j.device_id AS "deviceId",j.project_id AS "projectId",j.installed_package->'plugin'->>'id' AS "assetId",
                j.installed_package->'plugin'->>'kind' AS "assetKind",(j.installed_package->'plugin'->>'version')::int AS version,
                j.installed_package->'plugin'->>'name' AS name,j.installed_package->'manifest'->>'sha256' AS manifest,
                j.updated_at AS "updatedAt",j.installed_binding AS "bindingId",d.report->'bindings' AS bindings,j.installed_package->'config' AS "installedConfig",diagnostic.inspection,runtime_probe.runtime,runtime_probe.runtime_source AS "runtimeSource",runtime_probe.observed_at AS "runtimeObservedAt"
            FROM latest j JOIN bridge_devices d ON d.id=j.device_id
            LEFT JOIN LATERAL (
                SELECT checked.result AS inspection FROM bridge_jobs checked
                WHERE checked.email=j.email AND checked.device_id=j.device_id AND checked.project_id=j.project_id
                    AND checked.kind='inspect-installation' AND checked.state='succeeded'
                    AND checked.payload->>'bindingId'=j.installed_binding
                    AND checked.payload->'package'->'plugin'->>'kind'=j.installed_package->'plugin'->>'kind'
                    AND checked.payload->'package'->'plugin'->>'id'=j.installed_package->'plugin'->>'id'
                    AND checked.payload->'package'->'plugin'->>'version'=j.installed_package->'plugin'->>'version'
                    AND checked.payload->'package'->'manifest'->>'sha256'=j.installed_package->'manifest'->>'sha256'
                    AND checked.result->'schemaVersion'='1'::jsonb
                    AND COALESCE(checked.started_at,checked.created_at)>=COALESCE(j.started_at,j.created_at)
                    AND NOT EXISTS (SELECT 1 FROM bridge_jobs changed WHERE changed.email=j.email AND changed.device_id=j.device_id
                        AND changed.project_id=j.project_id AND changed.kind='apply-local-restore' AND changed.state='succeeded'
                        AND changed.payload->>'bindingId'=j.installed_binding
                        AND ((changed.payload->'package'->'plugin'->>'id'=j.installed_package->'plugin'->>'id'
                                AND changed.payload->'package'->'plugin'->>'kind'=j.installed_package->'plugin'->>'kind')
                            OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(changed.payload->'installSet'->'packages','[]'::jsonb)) member
                                WHERE member->'plugin'->>'id'=j.installed_package->'plugin'->>'id'
                                    AND member->'plugin'->>'kind'=j.installed_package->'plugin'->>'kind'))
                        AND COALESCE(changed.started_at,changed.created_at)>=COALESCE(checked.started_at,checked.created_at))
                ORDER BY COALESCE(checked.started_at,checked.created_at) DESC,checked.id DESC LIMIT 1
            ) diagnostic ON true
            LEFT JOIN LATERAL (
                SELECT checked.result AS runtime,checked.payload AS runtime_source,COALESCE(checked.started_at,checked.created_at) AS observed_at FROM bridge_jobs checked
                WHERE checked.email=j.email AND checked.device_id=j.device_id AND checked.project_id=j.project_id
                    AND checked.kind='probe-runtime' AND checked.state IN ('succeeded','failed')
                    AND checked.payload->>'bindingId'=j.installed_binding
                    AND checked.payload->'package'->'plugin'->>'kind'=j.installed_package->'plugin'->>'kind'
                    AND checked.payload->'package'->'plugin'->>'id'=j.installed_package->'plugin'->>'id'
                    AND checked.payload->'package'->'plugin'->>'version'=j.installed_package->'plugin'->>'version'
                    AND checked.payload->'package'->'manifest'->>'sha256'=j.installed_package->'manifest'->>'sha256'
                    AND COALESCE(checked.started_at,checked.created_at)>=COALESCE(j.started_at,j.created_at)
                    AND NOT EXISTS (SELECT 1 FROM bridge_jobs changed WHERE changed.email=j.email AND changed.device_id=j.device_id
                        AND changed.project_id=j.project_id AND changed.kind='apply-local-restore' AND changed.state='succeeded'
                        AND changed.payload->>'bindingId'=j.installed_binding
                        AND ((changed.payload->'package'->'plugin'->>'id'=j.installed_package->'plugin'->>'id'
                                AND changed.payload->'package'->'plugin'->>'kind'=j.installed_package->'plugin'->>'kind')
                            OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(changed.payload->'installSet'->'packages','[]'::jsonb)) member
                                WHERE member->'plugin'->>'id'=j.installed_package->'plugin'->>'id'
                                    AND member->'plugin'->>'kind'=j.installed_package->'plugin'->>'kind'))
                        AND COALESCE(changed.started_at,changed.created_at)>=COALESCE(checked.started_at,checked.created_at))
                ORDER BY COALESCE(checked.started_at,checked.created_at) DESC,checked.id DESC LIMIT 1
            ) runtime_probe ON true
            WHERE j.installed_action='install' AND NOT d.revoked
                AND ($2::boolean OR j.project_id=ANY($3::text[]))
            ORDER BY j.updated_at DESC`,
                [
                    actor.email,
                    actor.activeRole === 'Главный админ' &&
                        claims.userRoles.includes(actor.activeRole),
                    projects,
                ],
            )
        ).rows;
        const result=await Promise.all(rows.map(async ({ bindings, inspection, runtime, runtimeSource,installedConfig, ...item }) => {
            const current = Array.isArray(bindings) ? bindings.find(binding => binding?.projectId === item.projectId) : undefined;
            const isCurrentBinding = !!item.bindingId && current?.valid !== false && current?.bindingId === item.bindingId;
            let verifiedInspection: InstallationInspection | undefined;
            let verifiedRuntime: RuntimeProbeResult | undefined;
            let schemaDigest:string|undefined;
            try{schemaDigest=configurationSchemaDigest({plugin:{id:item.assetId,kind:item.assetKind,name:item.name,version:item.version},config:installedConfig??null,
                schemaVersion:5,manifest:{sha256:item.manifest,filesCount:0,createdAt:''},files:[]});}catch{/* Некорректная схема не получает готовность настройки. */}
            const configuration=schemaDigest&&isCurrentBinding&&current?.instanceId?await readConfigurationState(this.store.pool,actor.email,{deviceId:item.deviceId,projectId:item.projectId,
                bindingId:item.bindingId!,instanceId:current.instanceId,package:{plugin:{id:item.assetId,kind:item.assetKind,name:item.name,version:item.version},config:installedConfig??null,
                    schemaVersion:5,manifest:{sha256:item.manifest,filesCount:0,createdAt:''},files:[]}}):undefined;
            if (runtime && runtimeSource) {
                try {
                    assertRuntimeProbe(runtime,{...runtimeSource,projectId:item.projectId,bindingId:item.bindingId ?? undefined});
                    verifiedRuntime=runtime;
                } catch { /* Неподдерживаемая диагностика не показывается как успешный запуск. */ }
            }
            if (inspection) {
                try {
                    assertInstallationInspection(inspection,{projectId:item.projectId,bindingId:item.bindingId ?? undefined,
                        package:{plugin:{id:item.assetId,kind:item.assetKind,version:item.version},manifest:{sha256:item.manifest}}});
                    verifiedInspection=inspection;
                } catch { /* Повреждённая или чужая JSONB-сверка не попадает в интерфейс. */ }
            }
            let ragUi: {supported:true;mode:'web'}|undefined;
            try{if(localRagUi({schemaVersion:5,plugin:{kind:item.assetKind},config:installedConfig}))ragUi={supported:true,mode:'web'};}catch{/* Неизвестный descriptor не обещает интерфейс. */}
            return { ...item,...(supportsLearningQuirks({schemaVersion:5,plugin:{kind:item.assetKind},config:installedConfig})?{learningQuirks:{supported:true as const}}:{}),...(memoryRecipeSupported({schemaVersion:5,plugin:{kind:item.assetKind},config:installedConfig})?{learningMemory:{supported:true as const}}:{}),...(ragUi?{ragUi}:{}),...(ragUi&&supportsHostedRag({config:installedConfig})?{hostedEmbedding:{supported:true,...((installedConfig?.extra?.hostedEmbedding as {reindexSchemaVersion?:unknown}|undefined)?.reindexSchemaVersion===1?{reindexSupported:true}:{})}}:{}), bindingChanged: !isCurrentBinding, isCurrentBinding,
                ...(!item.bindingId ? { legacyBinding: true } : {}),
                ...(verifiedInspection ? { inspection:verifiedInspection } : {}),
                ...(verifiedRuntime && isCurrentBinding ? {runtime:verifiedRuntime} : {}),
                ...(schemaDigest?{configurationSchemaDigest:schemaDigest}:{}),
                ...(configuration?.status?{configuration:configuration.status}:{}),
                ...(configuration?.observedAt?{configurationObservedAt:configuration.observedAt}:{}),
                ...(configuration?.invalidatedAt?{configurationInvalidatedAt:configuration.invalidatedAt}:{}),
                ...(isCurrentBinding && typeof current?.folderName === 'string' ? { folderName: current.folderName } : {}) };
        }));
        for(const item of result){
            if(item.runtime?.configurationRevisions?.some(ref=>!result.some(member=>member.deviceId===item.deviceId&&member.projectId===item.projectId&&member.bindingId===item.bindingId
                &&member.assetId===ref.assetId&&member.manifest===ref.manifest&&member.configuration?.ready&&member.configuration.revision===ref.revision))){
                item.runtime={...item.runtime,status:'stale',code:'configuration-changed'};
            }
        }
        return result;
    }
    async removalPackage(actor: IAccessActor, input: InstallationInput): Promise<IPackage> {
        return this.installedPackage(actor, input);
    }
    /** Диагностика читает тот же сохранённый пакет и не требует нового одобрения кода. */
    async inspectionPackage(actor: IAccessActor, input: InstallationInput,db?:Pick<PoolClient,'query'>): Promise<IPackage> {
        return this.installedPackage(actor, input,db);
    }
    /** Чтение копий сохраняет исходный граф даже после отзыва одобрения. */
    async inspectionDelivery(actor:IAccessActor,input:InstallationInput):Promise<{package:IPackage;installSet?:IInstallationSet}> {
        const pkg=await this.installedPackage(actor,input);
        const {rows}=await this.store.pool.query(`${latest} SELECT payload FROM latest WHERE device_id=$2 AND project_id=$3
            AND installed_package->'plugin'->>'id'=$4 AND installed_package->'plugin'->>'kind'=$5 AND installed_binding=$6`,
        [actor.email,input.deviceId,input.projectId,input.assetId,input.assetKind,input.bindingId]);
        const set=rows[0]?.payload?.installSet as IInstallationSet|undefined;
        if(set&&verifyInstallationSet(set)&&set.root.id===pkg.plugin.id&&set.root.kind===pkg.plugin.kind&&set.root.manifest===pkg.manifest.sha256)return {package:pkg,installSet:set};
        if(packageDependencies(pkg).length){
            const members=[pkg];const found=new Set([pkg.plugin.kind+':'+pkg.plugin.id]);
            for(let index=0;index<members.length;index++)for(const pin of packageDependencies(members[index])){
                const key=pin.kind+':'+pin.id;if(found.has(key))continue;
                if(members.length>=20)throw new ConflictException('Закреплённый комплект превышает лимит 20 инструментов.');
                const {rows:children}=await this.store.pool.query(`${latest} SELECT installed_package AS package FROM latest
                    WHERE device_id=$2 AND project_id=$3 AND installed_binding=$6 AND installed_action='install'
                    AND installed_package->'plugin'->>'id'=$4 AND installed_package->'plugin'->>'kind'=$5
                    AND installed_package->'plugin'->>'version'=$7 AND installed_package->'manifest'->>'sha256'=$8`,
                [actor.email,input.deviceId,input.projectId,pin.id,pin.kind,input.bindingId,String(pin.version),pin.manifest]);
                if(children.length!==1)throw new ConflictException('В истории папки отсутствует точная зависимость установленного комплекта.');
                members.push(children[0].package);found.add(key);
                if(Buffer.byteLength(JSON.stringify(members))>24*1024*1024)throw new ConflictException('История комплекта превышает допустимый размер.');
            }
            return {package:pkg,installSet:installedGraph(pkg,members)};
        }
        return {package:pkg};
    }
    private async installedPackage(actor: IAccessActor, input: InstallationInput,db:Pick<PoolClient,'query'>=this.store.pool): Promise<IPackage> {
        if (
            !input.assetId ||
            typeof input.assetId !== 'string' ||
            input.assetId.length > 512 ||
            !['skill', 'mcp', 'plugin'].includes(input.assetKind || '') ||
            typeof input.expectedManifest !== 'string' ||
            !/^[a-f0-9]{64}$/.test(input.expectedManifest)
        ) {
            throw new BadRequestException(
                'Выберите установленный инструмент и актуальную квитанцию.',
            );
        }
        // У старой квитанции нет доказуемой папки; привязывать её к текущей папке автоматически нельзя.
        if (typeof input.bindingId !== 'string' || !/^[a-f0-9]{64}$/.test(input.bindingId)) {
            throw new ConflictException('Подтвердите текущую папку проекта. Установки без привязки удаляются только после ручной сверки.');
        }
        const { rows } = await db.query(
            `${latest} SELECT installed_action AS kind,jsonb_set(jsonb_set(payload,'{package}',installed_package),'{bindingId}',to_jsonb(installed_binding)) AS payload FROM latest WHERE device_id=$2 AND project_id=$3 AND installed_package->'plugin'->>'id'=$4 AND installed_package->'plugin'->>'kind'=$5 AND installed_binding=$6`,
            [
                actor.email,
                input.deviceId,
                input.projectId,
                input.assetId,
                input.assetKind,
                input.bindingId,
            ],
        );
        const pkg = rows[0]?.payload?.package as IPackage | undefined;
        if (rows[0] && rows[0].payload?.bindingId !== input.bindingId) {
            throw new ConflictException(!rows[0].payload?.bindingId
                ? 'Не сохранена привязка папки. Автоматическое удаление недоступно.'
                : 'Квитанция не подтверждает текущую папку проекта. Автоматическое удаление остановлено.');
        }
        let valid = false;
        try { valid = !!pkg && verifyPackage(pkg); } catch { /* Повреждённая история не разрешает удаление. */ }
        if (
            rows[0]?.kind !== 'install' ||
            !pkg ||
            !valid ||
            pkg.manifest.sha256 !== input.expectedManifest
        ) {
            throw new ConflictException(
                'Установка уже удалена или обновлена. Перечитайте список перед удалением.',
            );
        }
        return pkg;
    }
}
