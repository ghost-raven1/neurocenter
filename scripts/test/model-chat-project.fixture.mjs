import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {startModelChatFixture} from './model-chat.fixture.mjs';

/** Actual Catalog/Gateway, embedding provider, RAG HTTP controller and pgvector in one owned disposable DB. */
export async function startProjectChatFixture(options){
 const f=await startModelChatFixture(options),catalogRequire=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
 const ragRequire=createRequire(new URL('../../services/rag-sync-service/package.json',import.meta.url));
 const {RagDb}=ragRequire('./dist/rag/rag-db.js'),{RagService}=ragRequire('./dist/rag/rag.service.js');
 const {ProjectDatabases}=ragRequire('./dist/rag/project-databases.js'),{ProjectRagController}=ragRequire('./dist/rag/project-rag.controller.js');
 const {Module}=ragRequire('@nestjs/common'),{NestFactory}=ragRequire('@nestjs/core');
 const url=new URL(options.adminUrl);url.pathname='/'+f.database;
 const db=new RagDb({url:url.href});let rag;
 const close=async()=>{try{if(rag)await rag.close();await db.close();}finally{await f.close();}};
 try{
  await db.setup();
  const databases={withProject:async(id,action)=>{assert.equal(id,f.projectId,'Project DB dispatch is scoped to the fixture project.');return action(db,id);}};
  class ProjectSearchFixture{}Module({controllers:[ProjectRagController],providers:[{provide:RagService,useValue:new RagService(databases)},{provide:ProjectDatabases,useValue:databases}]})(ProjectSearchFixture);
  rag=await NestFactory.create(ProjectSearchFixture,{logger:false,abortOnError:false});
  rag.use((req,res,next)=>{if(req.headers['x-neurocenter-internal']!==process.env.NEUROCENTER_INTERNAL_TOKEN)return res.status(403).json({message:'Internal token required.'});next();});
  await rag.listen(0,'127.0.0.1');const ragUrl='http://127.0.0.1:'+rag.getHttpServer().address().port;
  const chat=f.catalog.get(catalogRequire('./dist/model-chat/chat.service.js').ModelChatService);
  process.env.RAG_SERVICE_URL=ragUrl;
  const {ProjectRagClient}=catalogRequire('./dist/models/project-rag-client.js');
  Object.defineProperty(chat.projectContext,'client',{value:new ProjectRagClient()});
  const generation='initial-'+createHash('md5').update(f.projectId).digest('hex'),embedding=f.cards[2];
  const profile={provider:'openai',model:`neurocenter/${embedding.id}/sha256/${embedding.modelPin}`,dimension:3};
  const rows=[{id:'architecture',filePath:'docs/architecture.md',content:'Проект использует PostgreSQL и API Gateway. Ключи хранятся только на сервере.',description:'Архитектура проекта',startLine:1,endLine:4,
   language:'markdown',kind:'docs',role:null,quirkType:null,tags:null,embedding:[1,1,3]}];
  const {rowFingerprint,indexSnapshotHash}=catalogRequire('../shared/rag-index-contract.cjs');
  const snapshot=indexSnapshotHash(profile,Object.fromEntries(rows.map(row=>[row.id,rowFingerprint(row)])));
  const upserts=rows.map(row=>({...row,contentHash:createHash('sha256').update(row.content).digest('hex')}));
  await db.applyDelta(f.projectId,generation,upserts,[],{indexProfile:profile,snapshot:{hash:snapshot,rowCount:1,complete:false}});
  await db.applyDelta(f.projectId,generation,[],[],{indexProfile:profile,snapshot:{hash:snapshot,rowCount:1,complete:true}});
  await f.pool.query(`INSERT INTO project_embedding_settings(project_id,revision,model_id,model_pin,dimension,active_generation,active_snapshot,data_revision,updated_by)
   VALUES($1,1,$2,$3,3,$4,$5,1,$6)`,[f.projectId,embedding.id,embedding.modelPin,generation,snapshot,f.actors.main.email]);
  f.provider.requests.length=0;
  return {...f,ragUrl,ragDb:db,chat,profile,generation,snapshot,close};
 }catch(error){await close();throw error;}
}
