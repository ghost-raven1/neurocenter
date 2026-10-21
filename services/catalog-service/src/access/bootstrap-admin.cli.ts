import {ensureCatalogSchema} from '../database/catalog-schema';
import '../../../shared/runtime.cjs';
import {Pool} from 'pg';
import {AccessDb} from './access-db';
import {bootstrapAdministrator} from './bootstrap-admin';

/** Команда доступна только оператору; публичного HTTP bootstrap нет. */
async function main():Promise<void> {
    if(!process.env.BOOTSTRAP_ADMIN_EMAIL?.trim()){throw new Error('Заполните BOOTSTRAP_ADMIN_EMAIL в production-конфиге.');}
    if(process.env.SSO_DISABLE==='true'){throw new Error('Bootstrap production-администратора нельзя выполнять с dev-входом.');}
    const access=new AccessDb();const pool=new Pool({connectionString:process.env.CATALOG_PG_URL});
    try{await ensureCatalogSchema(pool);await access.onModuleInit();const result=await bootstrapAdministrator(pool,{email:process.env.BOOTSTRAP_ADMIN_EMAIL,displayName:process.env.BOOTSTRAP_ADMIN_NAME});console.log(JSON.stringify({ok:true,created:result.created}));}
    finally{await access.onModuleDestroy();await pool.end();}
}
void main().catch(error=>{console.error(error instanceof Error?error.message:'Не удалось создать первого администратора.');process.exitCode=1;});
