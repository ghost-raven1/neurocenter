import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {ForbiddenException} from '@nestjs/common';
import {buildPackage,type IPackage} from '../src/catalog/bundle-package';
import type {Device,DeviceStore} from '../src/devices/device-store';
import {runtimeArtifactTarget} from '../src/devices/runtime-host-target';
import {authorizeHostedMcp,authorizeHostedMcpSession,hostedMcpSessionInput} from '../src/devices/mcp-host-access';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {connection,database,reset,main,admin,developer} from './agent-postgres.fixture';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
const artifact={target:runtimeArtifactTarget(),sha256:'d'.repeat(64),compressedBytes:100,unpackedBytes:200,filesCount:2,entrypoint:'server.mjs'};
const makePackage=(extra:Record<string,unknown>={})=>buildPackage({id:'hosted-test',kind:'mcp',name:'Hosted QA',version:1},[],'',{
    transport:'stdio',args:[],extra:{runtimeArtifacts:[artifact],hostedMcp:true,...extra}});
const report=()=>({protocolVersion:2,capabilities:['durable-completions','managed-installations'],bindings:[{projectId:'prj-agents',bindingId:'a'.repeat(64),valid:true}]});
const body=(device:Device,pkg:IPackage)=>({deviceId:device.id,projectId:'prj-agents',assetId:pkg.plugin.id,version:pkg.plugin.version,manifest:pkg.manifest.sha256,artifactSha256:artifact.sha256});

describe('Hosted MCP session identifiers',()=>{
    const valid=body({id:randomUUID()} as Device,makePackage());
    it('admits identifiers only without arbitrary credential/package fields',()=>{
        expect(hostedMcpSessionInput(valid)).toEqual(valid);
        for(const input of [{...valid,apiKey:'private'}, {...valid,pkg:{}}, {...valid,version:'1'}, {...valid,deviceId:'not-a-device'}, {...valid,manifest:'x'}, null, []])expect(()=>hostedMcpSessionInput(input)).toThrow();
    });
});

describe.skipIf(!connection)('Hosted MCP fresh authorization — isolated PostgreSQL',()=>{
    let fixture:Awaited<ReturnType<typeof database>>,pool:Pool,store:DeviceStore,device:Device,pkg:IPackage;
    beforeAll(async()=>{
        if(new URL(connection!).port==='5432')throw Error('Separate QA PostgreSQL port required');
        fixture=await database();pool=fixture.pool;store={pool} as DeviceStore;
    });
    afterAll(async()=>fixture?.close());
    const pin=async(current=pkg,project='prj-agents')=>pool.query(`INSERT INTO project_assets(project_id,asset_id,asset_kind,added_by,asset_version,asset_manifest,pin_origin,pin_snapshot)
        VALUES($1,$2,'mcp',$3,$4,$5,'assigned',$6) ON CONFLICT(project_id,asset_kind,asset_id) DO UPDATE SET asset_version=excluded.asset_version,asset_manifest=excluded.asset_manifest,pin_snapshot=excluded.pin_snapshot`,
        [project,current.plugin.id,main.email,current.plugin.version,current.manifest.sha256,{card:{id:current.plugin.id},package:current}]);
    const authorize=()=>authorizeHostedMcp(store,device,{projectId:'prj-agents',pkg});
    const session=()=>authorizeHostedMcpSession(store,body(device,pkg));
    beforeEach(async()=>{
        await reset(pool);vi.mocked(requireFeaturesEnabled).mockReset().mockResolvedValue(undefined);pkg=makePackage();
        device={id:randomUUID(),email:developer.email,role:developer.activeRole,name:'Hosted QA',fingerprint:randomUUID(),last_seen:null,revoked:false,report:report()};
        await pool.query('INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report) VALUES($1,$2,$3,$4,$5,$6,$7)',[device.id,device.email,device.role,device.name,device.fingerprint,randomUUID(),device.report]);
        await pool.query('INSERT INTO bridge_runtime_artifacts(sha256,compressed_bytes,unpacked_bytes,files_count) VALUES($1,$2,$3,$4) ON CONFLICT(sha256) DO UPDATE SET compressed_bytes=excluded.compressed_bytes,unpacked_bytes=excluded.unpacked_bytes,files_count=excluded.files_count',[artifact.sha256,artifact.compressedBytes,artifact.unpackedBytes,artifact.filesCount]);
        await pin();
    });
    it.each([developer,admin,main])('allows current %s only for the exact approved project runtime',async actor=>{
        await pool.query('UPDATE bridge_devices SET email=$2,role=$3 WHERE id=$1',[device.id,actor.email,actor.activeRole]);
        const result=await authorize();expect(result).toEqual({assetId:pkg.plugin.id,name:pkg.plugin.name,session:{deviceId:device.id,projectId:'prj-agents',assetId:pkg.plugin.id,version:1,manifest:pkg.manifest.sha256},artifact:{...artifact,executable:false}});
        expect(await session()).toEqual({ok:true});expect(JSON.stringify(result)).not.toMatch(/token_hash|fingerprint|email|apiKey|config|report/);
    });
    it('a valid self-signed package cannot substitute another globally registered artifact under an assigned ID',async()=>{
        const different={...artifact,sha256:'e'.repeat(64)};
        await pool.query('INSERT INTO bridge_runtime_artifacts(sha256,compressed_bytes,unpacked_bytes,files_count) VALUES($1,100,200,2)',[different.sha256]);
        pkg=buildPackage(pkg.plugin,[],'',{transport:'stdio',extra:{hostedMcp:true,runtimeArtifacts:[different]}});
        await expect(authorize()).rejects.toHaveProperty('status',409);
    });
    it('an assigned tool in a foreign project grants no access through this device',async()=>{
        await pin(pkg,'prj-other');await expect(authorizeHostedMcp(store,device,{projectId:'prj-other',pkg})).rejects.toHaveProperty('status',403);
        await expect(authorizeHostedMcpSession(store,{...body(device,pkg),projectId:'prj-other'})).rejects.toHaveProperty('status',403);
    });
    it.each(['grant','observer','account','main-role','device','expired','project'])('fresh %s revocation blocks both install and an existing ticket',async issue=>{
        await authorize();
        if(issue==='grant')await pool.query('DELETE FROM project_members WHERE principal_name=$1',[developer.email]);
        if(issue==='observer')await pool.query("UPDATE project_members SET role='Наблюдатель' WHERE principal_name=$1",[developer.email]);
        if(issue==='account')await pool.query('UPDATE platform_users SET enabled=false WHERE email=$1',[developer.email]);
        if(issue==='main-role'){await pool.query("UPDATE bridge_devices SET role='Главный админ' WHERE id=$1",[device.id]);}
        if(issue==='device')await pool.query('UPDATE bridge_devices SET revoked=true WHERE id=$1',[device.id]);
        if(issue==='expired')await pool.query("UPDATE bridge_devices SET expires_at=now()-interval '1 minute' WHERE id=$1",[device.id]);
        if(issue==='project')await pool.query("DELETE FROM projects WHERE id='prj-agents'");
        await expect(authorize()).rejects.toHaveProperty('status',403);await expect(session()).rejects.toHaveProperty('status',403);
    });
    it.each(['missing','invalid','old-bridge'])('fresh %s binding blocks existing tickets',async issue=>{
        await authorize();const next=report();if(issue==='missing')next.bindings=[];if(issue==='invalid')next.bindings[0].valid=false;if(issue==='old-bridge')next.capabilities=[];
        await pool.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[device.id,next]);await expect(session()).rejects.toHaveProperty('status',409);
    });
    it.each(['removed','version','manifest','artifact','inventory'])('fresh %s pin change invalidates a signed ticket',async issue=>{
        await authorize();
        if(issue==='removed')await pool.query("DELETE FROM project_assets WHERE project_id='prj-agents'");
        if(issue==='version'){const changed=buildPackage({...pkg.plugin,version:2},[],'',pkg.config);await pin(changed);}
        if(issue==='manifest'){const changed=buildPackage({...pkg.plugin,name:'Changed'},[],'',pkg.config);await pin(changed);}
        if(issue==='inventory')await pool.query('UPDATE bridge_runtime_artifacts SET files_count=3 WHERE sha256=$1',[artifact.sha256]);
        await expect(authorizeHostedMcpSession(store,{...body(device,pkg),...(issue==='artifact'?{artifactSha256:'e'.repeat(64)}:{})})).rejects.toHaveProperty('status',409);
    });
    it.each(['marker','args','env','local'])('refuses %s configuration the hosted runtime would ignore',async issue=>{
        let config=makePackage().config!;if(issue==='marker')config={...config,extra:{...config.extra,hostedMcp:false}};if(issue==='args')config={...config,args:['--private']};if(issue==='env')config={...config,env:{SECRET:'private'}};if(issue==='local')config={...config,extra:{...config.extra,localConfiguration:{}}};
        pkg=buildPackage(pkg.plugin,[],'',config);await pin();await expect(authorize()).rejects.toHaveProperty('status',409);
    });
    it('install-off refuses new tickets while an existing ordinary session remains usable',async()=>{
        await authorize();vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ForbiddenException('off'));
        await expect(authorize()).rejects.toHaveProperty('status',403);vi.mocked(requireFeaturesEnabled).mockClear();expect(await session()).toEqual({ok:true});expect(requireFeaturesEnabled).not.toHaveBeenCalled();
    });
    it('research sessions freshly require research and tool catalog capabilities',async()=>{
        pkg=makePackage({researchMcp:{adapter:'exa',tools:['web_search_exa','web_fetch_exa']}});await pin();await authorize();
        vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ForbiddenException('research off'));await expect(session()).rejects.toHaveProperty('status',403);expect(requireFeaturesEnabled).toHaveBeenLastCalledWith(['research_tools','tool_catalog']);
    });
});
