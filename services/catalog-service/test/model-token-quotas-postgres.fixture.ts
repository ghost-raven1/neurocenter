import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {MODEL_USAGE_SCHEMA_SQL} from '../src/model-usage/model-usage.schema';
import {MODEL_USAGE_DETAILS_SCHEMA_SQL} from '../src/model-usage/model-usage-details.schema';
import {MODEL_TOKEN_QUOTAS_SCHEMA_SQL} from '../src/model-token-quotas/model-token-quotas.schema';
import {ModelUsageRepository} from '../src/model-usage/model-usage.repository';
import {ModelTokenQuotasRepository} from '../src/model-token-quotas/model-token-quotas.repository';
import type {IModel} from '../src/models/model.types';
import type {ModelTokenQuotaEstimate} from '../src/model-token-quotas/model-token-quotas.types';

export const quotaAdminUrl=process.env.MODEL_TOKEN_QUOTA_TEST_ADMIN_PG_URL;
export const quotaModel:IModel={id:'model-token-fixture',name:'Quota fixture',description:'',runtime:'remote-openai',capability:'chat',model:'fixture/model',modelVersion:'1',
    manifestSha256:null,verificationSha256:'a'.repeat(64),modelPin:'a'.repeat(64),dimension:null,source:'custom',revision:1,createdAt:'',updatedAt:''};
export const quotaWriter='admin@example.test',quotaUser='user@example.test';
export const quotaEstimate=(total=50):ModelTokenQuotaEstimate=>({version:'server-text-v1',inputTokens:Math.min(10,total),outputTokens:Math.max(0,total-10),totalTokens:total,
    outputBasis:'planning-default',modelPin:quotaModel.modelPin!,requestDigest:'b'.repeat(64),supported:true});
/** Only an explicit own admin URL creates a random disposable database; there is no live DB fallback. */
export async function quotaPostgresFixture(){
    if(!quotaAdminUrl)throw new Error('Own quota PostgreSQL URL is required.');
    let target:URL;try{target=new URL(quotaAdminUrl);}catch{throw Error('An explicit own loopback PostgreSQL admin URL is required.');}
    if(!['postgres:','postgresql:'].includes(target.protocol)||target.hostname!=='127.0.0.1'||!target.port||target.port==='5432'||target.pathname!=='/postgres'||target.search||target.hash)
        throw Error('Quota QA requires its own loopback non5432 PostgreSQL cluster; live DB targets are refused.');
    const database='nc_token_quota_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:quotaAdminUrl,max:1});
    await admin.query('CREATE DATABASE '+database);
    const url=new URL(quotaAdminUrl);url.pathname='/'+database;
    const pool=new Pool({connectionString:url.toString(),max:6,connectionTimeoutMillis:1000,lock_timeout:500,statement_timeout:2000,query_timeout:2500});
    try{
        await pool.query(`CREATE TABLE platform_users(email text PRIMARY KEY,enabled boolean NOT NULL,is_main_admin boolean NOT NULL);
 CREATE TABLE model_catalog(id text PRIMARY KEY,descriptor jsonb NOT NULL,archived_at timestamptz);`);
        await pool.query(MODEL_USAGE_SCHEMA_SQL);await pool.query(MODEL_USAGE_DETAILS_SCHEMA_SQL);
        await pool.query('ALTER TABLE model_usage_calls ADD COLUMN private_project_chat_room_id uuid');
        await pool.query(MODEL_TOKEN_QUOTAS_SCHEMA_SQL);
        await pool.query('CREATE TABLE quota_tx_probe(id text PRIMARY KEY)');
        await pool.query('INSERT INTO platform_users VALUES($1,true,true),($2,true,false)',[quotaWriter,quotaUser]);
        await pool.query('INSERT INTO model_catalog VALUES($1,$2::jsonb,NULL)',[quotaModel.id,JSON.stringify(quotaModel)]);
    }catch(error){await pool.end();await admin.query('DROP DATABASE '+database);await admin.end();throw error;}
    const usage=new ModelUsageRepository(pool),policies=new ModelTokenQuotasRepository(pool),worker=randomUUID();
    return {pool,usage,policies,worker,databaseUrl:url.toString(),
        async reset(){await pool.query('TRUNCATE model_usage_calls,model_user_token_quota_requests,model_user_token_quotas,quota_tx_probe');},
        async policy(limit=100,revision=0,periodMs=86400000,enabled=true,key=randomUUID()){
            return policies.save(quotaWriter,quotaModel,quotaUser,{requestKey:key,expectedRevision:revision,tokenLimit:limit,periodMs,enabled});
        },
        async begin(){const id=randomUUID();await usage.begin({id,workerId:worker,actorEmail:quotaUser,purpose:'direct',endpoint:'chat',model:quotaModel});return id;},
        reserve(id:string,total=50){return usage.reserveQuota(worker,{usageId:id,userEmail:quotaUser,model:quotaModel,estimate:quotaEstimate(total)});},
        async close(){await pool.end();try{await admin.query('DROP DATABASE '+database);}finally{await admin.end();}},
    };
}
