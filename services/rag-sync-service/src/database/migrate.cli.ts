import {ragMigrationManifest} from './migration-definitions';

/** Offline manifest works before secrets or PostgreSQL exist; errors never disclose a connection URL. */
async function main():Promise<void>{
    const args=process.argv.slice(2),mode=args[0],requireReady=mode==='check'&&args.length===2&&args[1]==='--ready';
    if(args.length!==1&&!requireReady)throw Error('Неизвестные аргументы миграций RAG.');
    if(mode==='manifest'){console.log(JSON.stringify(ragMigrationManifest()));return;}
    if(mode!=='check'&&mode!=='migrate')throw Error('Используйте manifest, check или migrate.');
    require('../../../shared/runtime.cjs');
    const {createPool}=await import('./pool');const {checkBaseMigrations,migrateBase}=await import('./migration-cli');
    const url=process.env.RAG_PG_URL;if(!url)throw Error('Не настроено подключение RAG PostgreSQL.');
    const pool=createPool({connectionString:url,max:2},'rag-migrations-cli');
    try{const result=mode==='check'?await checkBaseMigrations(pool):await migrateBase(pool,url);
        if(requireReady&&!result.ready)throw Error('Сначала примените миграции RAG.');
        console.log(JSON.stringify(result));}finally{await pool.end();}
}
void main().catch(()=>{console.error('Не удалось проверить или применить миграции RAG. Проверьте историю, структуру схемы и доступ к PostgreSQL.');process.exitCode=1;});
