import {BadRequestException,ConflictException,ForbiddenException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import type {Device,DeviceStore} from './device-store';
import type {IPackage} from '../catalog/bundle-package';
import {verifyPackage} from '../catalog/bundle-package';
import {projectAssetColumns,checkedProjectPackage,type IProjectPinRow} from '../catalog/project-asset-pins';
import {ROLES,type IAccessClaims} from '../access/access.model';
import {hasDeviceJobPermission} from './device-job-access';
import {assertManagedBridge,managedBinding} from './device-compatibility';
import {normalizeRuntimeArtifacts} from '../../../shared/runtime-artifacts.cjs';
import {runtimeArtifactTarget} from './runtime-host-target';
import {requireFeaturesEnabled} from '../features/require-feature-enabled';

export interface HostedMcpSession {deviceId:string;projectId:string;assetId:string;version:number;manifest:string;}
interface SessionInput extends HostedMcpSession {artifactSha256:string;}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x20\x7f]/.test(value);
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const mismatch=()=>new ConflictException('Пакет хоста изменился или больше не назначен проекту. Повторите установку актуальной версии.');
/** The ticket carries identifiers only; credentials and arbitrary package bytes cannot extend its access. */
export function hostedMcpSessionInput(value:unknown):SessionInput{
    const body=value as Partial<SessionInput>|null;
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='artifactSha256,assetId,deviceId,manifest,projectId,version'
        ||!uuid(body.deviceId)||!text(body.projectId,200)||!text(body.assetId,512)||!Number.isSafeInteger(body.version)||Number(body.version)<1||!sha(body.manifest)||!sha(body.artifactSha256))throw new BadRequestException('Нужна точная сессия управляемого MCP. Повторите установку.');
    return body as SessionInput;
}
async function deviceProject(db:PoolClient,id:string,projectId:string):Promise<Device>{
    const device=(await db.query<Device>('SELECT * FROM bridge_devices WHERE id=$1 AND NOT revoked AND expires_at>now() FOR SHARE',[id])).rows[0];
    if(!device)throw new ForbiddenException('Подключение компьютера отозвано или истекло.');
    const user=(await db.query<{enabled:boolean;is_main_admin:boolean}>('SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',[device.email])).rows[0];
    if(!user?.enabled)throw new ForbiddenException('Учётная запись отключена.');
    const projects=(await db.query<IAccessClaims['projects'][number]>(`SELECT pm.project_id AS "projectId",p.name AS "projectName",pm.role FROM project_members pm
        JOIN projects p ON p.id=pm.project_id WHERE lower(pm.principal_name)=$1 FOR SHARE OF pm,p`,[device.email])).rows;
    const claims:IAccessClaims={email:device.email,projects,userRoles:ROLES.filter(role=>role==='Главный админ'?user.is_main_admin:projects.some(project=>project.role===role)),pluginIds:[],skillPaths:[]};
    if(!hasDeviceJobPermission(claims,device.role,device.role,projectId,2))throw new ForbiddenException('Хост MCP требует доступа разработчика к выбранному проекту.');
    if(!(await db.query('SELECT id FROM projects WHERE id=$1 FOR SHARE',[projectId])).rowCount)throw new ForbiddenException('Проект недоступен.');
    assertManagedBridge(device.report);managedBinding(device.report,projectId);
    return device;
}
async function approvedPackage(db:PoolClient,projectId:string,assetId:string,version:number,manifest:string):Promise<IPackage>{
    const row=(await db.query<IProjectPinRow>(`SELECT ${projectAssetColumns} FROM project_assets
        WHERE project_id=$1 AND asset_kind='mcp' AND asset_id=$2 FOR SHARE`,[projectId,assetId])).rows[0];
    if(!row)throw mismatch();const pkg=checkedProjectPackage(row);
    if(pkg.plugin.kind!=='mcp'||pkg.plugin.version!==version||pkg.manifest.sha256!==manifest)throw mismatch();
    const config=pkg.config;
    if(!config||config.transport==='remote'||config.extra?.hostedMcp!==true||config.extra?.localConfiguration
        ||config.args?.length||config.env&&Object.keys(config.env).length)throw new ConflictException('Этот MCP требует локальных параметров или не разрешён для хостинга площадки.');
    return pkg;
}
async function hostArtifact(db:PoolClient,pkg:IPackage,expectedSha?:string){
    const artifact=normalizeRuntimeArtifacts(pkg.config?.extra?.runtimeArtifacts).find(item=>item.target===runtimeArtifactTarget());
    if(!artifact||expectedSha!==undefined&&artifact.sha256!==expectedSha)throw mismatch();
    const stored=(await db.query<{compressed_bytes:string;unpacked_bytes:string;files_count:number}>('SELECT compressed_bytes,unpacked_bytes,files_count FROM bridge_runtime_artifacts WHERE sha256=$1 FOR SHARE',[artifact.sha256])).rows[0];
    if(!stored||Number(stored.compressed_bytes)!==artifact.compressedBytes||Number(stored.unpacked_bytes)!==artifact.unpackedBytes||Number(stored.files_count)!==artifact.filesCount)throw mismatch();
    return artifact;
}
async function transaction<T>(store:DeviceStore,action:(db:PoolClient)=>Promise<T>):Promise<T>{
    const db=await store.pool.connect();try{await db.query('BEGIN');const result=await action(db);await db.query('COMMIT');return result;}
    catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}finally{db.release();}
}
/** New installation admits only the current project pin and an explicitly server-hosted, parameter-free runtime. */
export async function authorizeHostedMcp(store:DeviceStore,device:Device,value:unknown){
    const body=value as {projectId?:unknown;pkg?:IPackage}|null;
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='pkg,projectId'||!text(body.projectId,200)||!body.pkg)throw new BadRequestException('Нужны проект и закреплённый пакет MCP.');
    let valid=false;try{valid=verifyPackage(body.pkg);}catch{/* Invalid snapshots never reach an executable path. */}
    if(!valid||body.pkg.plugin.kind!=='mcp')throw mismatch();
    return transaction(store,async db=>{
        await deviceProject(db,device.id,body.projectId as string);await requireFeaturesEnabled(['tool_installation']);
        const pkg=await approvedPackage(db,body.projectId as string,body.pkg!.plugin.id,body.pkg!.plugin.version,body.pkg!.manifest.sha256),artifact=await hostArtifact(db,pkg);
        const session:HostedMcpSession={deviceId:device.id,projectId:body.projectId as string,assetId:pkg.plugin.id,version:pkg.plugin.version,manifest:pkg.manifest.sha256};
        return {assetId:pkg.plugin.id,name:pkg.plugin.name,session,artifact:{...artifact,executable:artifact.executable??false}};
    });
}
/** Every ticket operation rechecks revocation and the immutable assigned package without returning secrets. */
export async function authorizeHostedMcpSession(store:DeviceStore,value:unknown):Promise<{ok:true}>{
    const input=hostedMcpSessionInput(value);
    return transaction(store,async db=>{
        await deviceProject(db,input.deviceId,input.projectId);const pkg=await approvedPackage(db,input.projectId,input.assetId,input.version,input.manifest);
        await hostArtifact(db,pkg,input.artifactSha256);
        if(pkg.config?.extra?.researchMcp)await requireFeaturesEnabled(['research_tools','tool_catalog']);
        return {ok:true};
    });
}
