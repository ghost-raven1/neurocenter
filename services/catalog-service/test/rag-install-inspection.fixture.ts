import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {buildPackage,type IPackage} from '../src/catalog/bundle-package';
import {installationRef,installationRefs,installationSetHash,type IInstallationSet} from '../src/devices/installation-set';
import type {DeviceCompletion} from '../src/devices/device-completion';
import type {Job} from '../src/devices/device-job.model';
import type {Device} from '../src/devices/device-store';

export const ragBinding='b'.repeat(64),ragInstance='11111111-1111-4111-8111-111111111111',ragProject='prj-rag-inspection';

/** Frozen synthetic delivery bytes are never extracted or executed by these fixtures. */
export function ragPackage(kind:'mcp'|'plugin',dependencies:IPackage[]=[]):IPackage{
    const entrypoint=kind==='mcp'?'opencode-rag.mjs':'rag-plugin.mjs';
    return buildPackage({id:'ai-plug-rag-'+kind,name:'RAG '+kind,kind,version:9},[{path:'README.md',content:'Owned fixture'}],new Date(0).toISOString(),{
        ...(kind==='mcp'?{transport:'stdio' as const,command:'node',args:['mcp']}:{}),entrypoint,
        extra:{runtimeArtifacts:[{target:'linux-x64-glibc',sha256:'a'.repeat(64),compressedBytes:100,unpackedBytes:200,filesCount:1,entrypoint}],
            localUi:{schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:['ui','--port','0','--no-open']},
            hostedEmbedding:{schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1},
            ...(dependencies.length?{requirements:{dependencies:dependencies.map(installationRef)}}:{})},
    });
}

export function ragInstallSet():IInstallationSet{
    const mcp=ragPackage('mcp'),plugin=ragPackage('plugin',[mcp]),root=installationRef(plugin),packages=[mcp,plugin];
    return {schemaVersion:1,root,packages,manifest:installationSetHash(root,packages)};
}

export function ragDevice():Device{
    return {id:randomUUID(),email:'own@example.test',role:'Разработчик',name:'Owned RAG fixture',fingerprint:'owned',last_seen:null,revoked:false,
        report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','install-set-v1','installation-inspection-v1','package-v5'],
            bindings:[{projectId:ragProject,bindingId:ragBinding,instanceId:ragInstance,valid:true}]}};
}

export function ragInstallJob(device=ragDevice(),set?:IInstallationSet,pkg=set?.packages.find(item=>item.plugin.id===set.root.id)??ragPackage('mcp')):Job{
    return {id:randomUUID(),device_id:device.id,email:device.email,role:device.role,project_id:ragProject,kind:'install',state:'running',percent:30,
        lease:randomUUID(),lease_until:new Date(Date.now()+60_000),
        payload:{assetId:pkg.plugin.id,assetKind:pkg.plugin.kind,version:pkg.plugin.version,bindingId:ragBinding,package:pkg,...(set?{installSet:set}:{})}};
}

export function installCompletion(job:Job,failed=false):DeviceCompletion{
    const pkg=job.payload.package as IPackage,set=job.payload.installSet as IInstallationSet|undefined;
    return {lease:job.lease,state:failed?'failed':'succeeded',message:'Файлы установлены',result:{projectId:job.project_id,assetId:pkg.plugin.id,
        version:pkg.plugin.version,manifest:set?.manifest??pkg.manifest.sha256,bindingId:job.payload.bindingId,
        ...(set?{packages:installationRefs(set.packages)}:{}),...(failed?{unchanged:true}:{})}};
}

export function inspectionCompletion(job:Job,failed=false):DeviceCompletion{
    const pkg=job.payload.package as IPackage;
    return {lease:job.lease,state:failed?'failed':'succeeded',message:'Файлы проверены',result:{schemaVersion:1,projectId:job.project_id,
        bindingId:job.payload.bindingId,assetId:pkg.plugin.id,assetKind:pkg.plugin.kind,version:pkg.plugin.version,manifest:pkg.manifest.sha256,
        checkedAt:new Date().toISOString(),readiness:'unverified',state:'checked',status:failed?'unknown':'synced',issues:failed?['read-failed']:[]}};
}

/** Add only the production queue columns omitted by the minimal existing completion fixture. */
export async function ragInspectionFixtureSchema(pool:Pool):Promise<void>{
    await pool.query(`ALTER TABLE bridge_devices ADD COLUMN email text,ADD COLUMN role text,ADD COLUMN report jsonb NOT NULL DEFAULT '{}';
        ALTER TABLE bridge_jobs ADD COLUMN request_key text NOT NULL DEFAULT gen_random_uuid()::text,ADD COLUMN request_hash text NOT NULL DEFAULT 'owned-seed';
        ALTER TABLE bridge_jobs ADD CONSTRAINT own_rag_request_unique UNIQUE(email,request_key);
        ALTER TABLE bridge_jobs ALTER COLUMN lease DROP NOT NULL,ALTER COLUMN lease_until DROP NOT NULL;
        CREATE TABLE projects(id text PRIMARY KEY);
        CREATE TABLE bridge_job_requests(email text NOT NULL,request_key text NOT NULL,device_id text NOT NULL REFERENCES bridge_devices(id),
            request_hash text NOT NULL,job_id text NOT NULL REFERENCES bridge_jobs(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(email,request_key));`);
}

export async function seedRagInstall(pool:Pool,device:Device,job:Job):Promise<void>{
    await pool.query('INSERT INTO projects(id) VALUES($1) ON CONFLICT DO NOTHING',[job.project_id]);
    await pool.query('INSERT INTO bridge_devices(id,email,role,report) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET report=EXCLUDED.report',[device.id,device.email,device.role,device.report]);
    await pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,state,percent,payload,lease,lease_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[job.id,job.device_id,job.email,job.role,job.project_id,job.kind,job.state,job.percent,job.payload,job.lease,job.lease_until]);
}
