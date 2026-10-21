import {CATALOG_MIGRATIONS} from './catalog-migrations';
import {migrationChecksum} from './migrations';
import {checkCatalogSchema,ensureCatalogSchema} from './catalog-schema';

/** Manifest is offline; database commands alone load private production environment files. */
async function main():Promise<void>{
    const [mode,...options]=process.argv.slice(2);
    if(!['manifest','check','migrate'].includes(mode)||options.length>1||options.some(value=>mode!=='check'||value!=='--ready')){
        throw new Error('Используйте manifest, check [--ready] или migrate.');
    }
    if(mode==='manifest'){
        console.log(JSON.stringify(CATALOG_MIGRATIONS.map(({version,name,sql})=>({version,name,checksum:migrationChecksum(sql)}))));return;
    }
    require('../../../shared/runtime.cjs');
    if(!process.env.CATALOG_PG_URL?.trim())throw new Error('Настройте закрытое подключение CATALOG_PG_URL.');
    const {createPool}=await import('./pool');
    const pool=createPool({connectionString:process.env.CATALOG_PG_URL,max:1},'catalog-migrations');
    try{
        if(mode==='migrate')await ensureCatalogSchema(pool);
        console.log(JSON.stringify(await checkCatalogSchema(pool,mode==='migrate'||options.includes('--ready'))));
    }finally{await pool.end();}
}
void main().catch(()=>{console.error('Схема каталога не подготовлена. Проверьте историю миграций, подключение и совместимость схемы.');process.exitCode=1;});
