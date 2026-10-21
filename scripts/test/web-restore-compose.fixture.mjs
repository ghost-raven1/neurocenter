import {mkdtemp,mkdir,writeFile,rm,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {configureProduction} from '../production/configuration.mjs';
import {composeClient,composeConfiguration,containers,docker,serviceImageIds} from '../production/compose-client.mjs';
import {writeManifest} from '../production/recovery-manifest.mjs';
import {volumeKeys} from '../production/recovery-files.mjs';
import {exportSnapshotRecovery} from '../production/snapshot-recovery-storage.mjs';

/** Real isolated PG16/Compose fixture. Only exact random projects and their own volumes are removed. */
export async function webRestoreComposeFixture({prepare=async()=>{},exportSnapshots=false}={}){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'nc-web-restore-'))),directory=path.join(root,'config'),backupRoot=path.join(root,'copies'),source=path.join(backupRoot,'checkpoint');
 const nonce=randomUUID().slice(0,12),sourceProject='nc-web-source-'+nonce,targetProject='nc-restore-'+nonce;
 await mkdir(backupRoot,{mode:0o700});await mkdir(source,{mode:0o700});
 await configureProduction({panelUrl:'https://restore-fixture.test',ssoHost:'https://sso.restore-fixture.test',adminEmail:'restore@example.test',ssoClientId:'restore-fixture',ssoClientSecret:randomUUID(),release:'restore-fixture',tlsCertFile:path.join(root,'cert.pem'),tlsKeyFile:path.join(root,'key.pem')},directory);
 const helper='node:24.22.0-bookworm-slim',initializer=process.env.WEB_RESTORE_FIXTURE_INIT_IMAGE||'neurocenter/catalog-service:recovery-fenced-20261018-092';
 const services=['frontend','api-gateway','oauth2-bridge','rag-sync-service','skills-service','catalog-service','feature-flags-service','capacity-collector'];
 const override=path.join(root,'isolated.yml');
 await writeFile(override,'services:\n'+services.map(name=>'  '+name+':\n    image: '+helper+'\n').join('')+'  database-init:\n    image: '+initializer+'\n',{mode:0o600});
 const files=[override],client=composeClient({directory,projectName:sourceProject,files}),target=composeClient({directory,projectName:targetProject,files});
 const dispose=async()=>{try{await target.run(['down','--volumes','--remove-orphans'],{timeout:60000});}finally{try{await client.run(['down','--volumes','--remove-orphans'],{timeout:60000});}finally{await rm(root,{recursive:true,force:true});}}};
 try{
  await client.run(['up','-d','--wait','postgres']);await client.run(['--profile','setup','run','--rm','database-init']);
  const pg=(await containers(client)).find(item=>item.Config.Labels['com.docker.compose.service']==='postgres');if(!pg?.State.Running)throw Error('Fixture PostgreSQL absent');
  const sql=(database,input)=>docker(['exec','-i',pg.Id,'psql','-X','-U','nc_owner','-d',database,'-v','ON_ERROR_STOP=1','-At'],{input});
  await sql('catalog',"SET ROLE nc_catalog; CREATE TABLE fixture_restore_values(id integer PRIMARY KEY,value text); INSERT INTO fixture_restore_values VALUES(1,'real PostgreSQL restore proof'); CREATE TABLE bridge_pairs(id integer); INSERT INTO bridge_pairs VALUES(1); CREATE TABLE bridge_devices(id integer,last_seen timestamptz); INSERT INTO bridge_devices VALUES(1,now());");
  const projectDatabase='nc_rag_'+randomUUID().replaceAll('-','');
  await sql('postgres','CREATE DATABASE '+projectDatabase+' OWNER nc_rag;');
  await sql(projectDatabase,"SET ROLE nc_rag; CREATE TABLE fixture_vectors(id integer PRIMARY KEY,values_json jsonb); INSERT INTO fixture_vectors VALUES(1,'[1,2,3]'::jsonb);");
  await sql('rag',"SET ROLE nc_rag; CREATE TABLE neurocenter_project_databases(database_name text PRIMARY KEY); INSERT INTO neurocenter_project_databases VALUES('"+projectDatabase+"');");
  await prepare({root,directory,source,sql});
  const databases=JSON.parse(await sql('postgres',"SELECT json_agg(json_build_object('name',datname,'owner',pg_get_userbyid(datdba),'encoding',pg_encoding_to_char(encoding),'collate',datcollate,'ctype',datctype,'file','databases/'||datname||'.dump') ORDER BY datname) FROM pg_database WHERE datname NOT IN ('template0','template1','postgres','nc_rag_template');"));
  await mkdir(path.join(source,'databases'),{mode:0o700});for(const db of databases)await docker(['exec',pg.Id,'pg_dump','-U','nc_owner','-d',db.name,'--format=custom'],{outputFile:path.join(source,db.file)});
  for(const volume of volumeKeys){await mkdir(path.join(source,'files',volume),{recursive:true,mode:0o700});await writeFile(path.join(source,'files',volume,'own-fixture.txt'),'exact '+volume+' data\n',{mode:0o600});}
  const snapshotObjects=exportSnapshots?await exportSnapshotRecovery({directory,destination:source,sql}):undefined;
  const config=await composeConfiguration(client),images=await serviceImageIds(config),receipt=await writeManifest(source,{createdAt:new Date().toISOString(),postgresMajor:16,postgresImage:pg.Image,images,quiesced:true,databases,...(snapshotObjects?{snapshotObjects}:{})});
  const registry=path.join(root,'checkpoints.json');await writeFile(registry,JSON.stringify({checkpoints:[{id:'real-compose-checkpoint',label:'Isolated real PG16 checkpoint',source:'checkpoint',sha256:receipt.sha256}]}),{mode:0o600});
  return {root,directory,backupRoot,source,registry,files,sourceProject,targetProject,projectDatabase,sha256:receipt.sha256,manifest:receipt.manifest,client,target,sql,dispose,
   verify:async()=>{const targetPg=(await containers(target)).find(item=>item.Config.Labels['com.docker.compose.service']==='postgres');if(!targetPg?.State.Running)throw Error('Target postgres absent');
    const query=(database,input)=>docker(['exec','-i',targetPg.Id,'psql','-X','-U','nc_owner','-d',database,'-v','ON_ERROR_STOP=1','-At'],{input});
    const row=await query('catalog','SELECT value FROM fixture_restore_values WHERE id=1;'),vectors=await query(projectDatabase,'SELECT values_json FROM fixture_vectors WHERE id=1;'),pairs=await query('catalog','SELECT count(*) FROM bridge_pairs;'),online=await query('catalog','SELECT count(*) FROM bridge_devices WHERE last_seen IS NOT NULL;');
    if(row!=='real PostgreSQL restore proof'||vectors!=='[1, 2, 3]'||pairs!=='0'||online!=='0')throw Error('Restored SQL differs');
    const states=await containers(target);if(states.some(item=>item.State.Running&&item.Config.Labels['com.docker.compose.service']!=='postgres'))throw Error('Target application started unexpectedly');
    for(const volume of volumeKeys)if(await readFile(path.join(source,'files',volume,'own-fixture.txt'),'utf8')!=='exact '+volume+' data\n')throw Error('Source copy mutated');
    if(await sql('catalog','SELECT count(*) FROM bridge_pairs;')!=='1')throw Error('Source cluster mutated');
    return {sqlRows:true,vectors:true,oldPairsCleared:true,devicesOffline:true,applicationsStarted:false,sourceUnchanged:true,databases:databases.length};
   }};
 }catch(error){await dispose();throw error;}
}
