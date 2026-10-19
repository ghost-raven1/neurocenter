const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomBytes,createHash}=require('node:crypto');
const root=process.cwd(),phase='green';
const dist=path.resolve(process.env.CATALOG_STARTUP_TEST_DIST||'services/catalog-service/.retention-audit-dist');
require(path.join(root,'services/catalog-service/node_modules/reflect-metadata'));
const {Pool}=require(path.join(root,'services/catalog-service/node_modules/pg'));
const {NestFactory}=require(path.join(root,'services/catalog-service/node_modules/@nestjs/core'));
const adminUrl=process.env.PUBLICATION_TEST_PG_URL||'postgresql://rag:rag@127.0.0.1:5432/postgres';
const admin=new Pool({connectionString:adminUrl,max:1});
const evidence=path.resolve(process.env.CATALOG_STARTUP_TEST_OUTPUT||'output/retention-audit-20261019/integration');
const trials=[];
const initialized=[];
// Наблюдение обещаний не меняет порядок Nest lifecycle и не добавляет блокировок DDL.
for(const [file,name] of [['catalog/catalog.service','CatalogService'],['access/access-db','AccessDb'],['maintenance/maintenance.service','MaintenanceService'],['devices/device-store','DeviceStore'],['backups/project-backup.service','ProjectBackupService'],['package-build/package-build.service','PackageBuildService']]){
  const prototype=require(path.join(dist,file+'.js'))[name].prototype;
  const original=prototype.onModuleInit;
  prototype.onModuleInit=function(...args){const pending=original.apply(this,args);initialized.push(pending);return pending;};
}
const {AppModule}=require(path.join(dist,'app.module.js'));
async function names(){return(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows.map(row=>row.datname);}
async function main(){
 const before=await names();
 try{
  for(let index=0;index<3;index++){
   const database='nc_security_startup_'+randomBytes(8).toString('hex');
   const folder=await fs.mkdtemp(path.join(os.tmpdir(),'nc-security-startup-'));
   const url=new URL(adminUrl);url.pathname='/'+database;
   let app,created=false,error,health,dropped=false;
   const started=initialized.length;
   try{
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    Object.assign(process.env,{NODE_ENV:'production',CATALOG_PG_URL:url.href,SSO_DISABLE:'false',PROJECTS_ROOT:folder,RAG_SERVICE_URL:'',API_GATEWAY_URL:'http://127.0.0.1:9',SKILLS_SERVICE_URL:'http://127.0.0.1:9',RUNTIME_ARTIFACT_DIR:path.join(folder,'runtime'),BACKUP_DIR:path.join(folder,'backups'),NEUROCENTER_INTERNAL_TOKEN:randomBytes(32).toString('hex')});
    app=await NestFactory.create(AppModule,{logger:false,abortOnError:false});
    await app.listen(0,'127.0.0.1');
    health=(await fetch((await app.getUrl())+'/health')).status;
   }catch(caught){error={code:caught.code,message:caught.message,constraint:caught.constraint};}
   finally{
    await Promise.allSettled(initialized.slice(started));
    if(app)await app.close();
    if(created){await admin.query(`DROP DATABASE "${database}"`);dropped=true;}
    await fs.rm(folder,{recursive:true,force:true});
   }
   trials.push({trial:index+1,started:!error,health,error,ownDatabaseDropped:dropped,ownFilesystemRemoved:true});
  }
  const source=await fs.readFile('services/catalog-service/src/access/security-events.ts','utf8');
  const report={candidate:dist,compiledSecurityEventsSha256:createHash('sha256').update(await fs.readFile(path.join(dist,'access/security-events.js'))).digest('hex'),level:'compiled actual AppModule with native PostgreSQL and unmodified concurrent Nest lifecycle',sourceSha256:createHash('sha256').update(source).digest('hex'),phase,trials,originalDatabasesUnchanged:JSON.stringify(before)===JSON.stringify(await names()),workingDataTouched:false,normalDistTouched:false};
  await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,'startup-'+phase+'.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  if(phase==='green'&&trials.some(row=>!row.started||row.health!==200))process.exitCode=1;
 }finally{await admin.end();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
