export const schemaServices=Object.freeze(['catalog-service','feature-flags-service','rag-sync-service']);
const checksumPattern=/^[a-f0-9]{64}$/;

/** Опись берётся из закреплённого образа, не из локальных исходников оператора. */
export function validateSchemaManifest(service,value){
    const scoped=service==='rag-sync-service',keys=scoped?['scope','version','name','checksum']:['version','name','checksum'];
    const seen=new Set();
    if(!schemaServices.includes(service)||!Array.isArray(value)||value.length===0||value.length>1000)throw new Error('Некорректная опись миграций '+service);
    for(const row of value){
        if(!row||typeof row!=='object'||Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key))
            ||(scoped?(typeof row.version!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(row.version)):(!Number.isSafeInteger(row.version)||row.version<0))
            ||typeof row.name!=='string'||!row.name.trim()||row.name.length>160||/[\x00-\x1f\x7f]/.test(row.name)
            ||typeof row.checksum!=='string'||!checksumPattern.test(row.checksum)||(scoped&&(typeof row.scope!=='string'||!/^[a-z][a-z0-9:_-]{0,63}$/.test(row.scope))))throw new Error('Некорректная опись миграций '+service);
        const key=JSON.stringify(scoped?[row.scope,row.version,row.name]:row.version);
        if(seen.has(key))throw new Error('Некорректная опись миграций '+service);seen.add(key);
    }
    return value;
}

/** Offline-проба не получает сеть, секреты, writable root или пользовательские тома. */
export async function inspectSchemaManifests(images,run){
    const entries=await Promise.all(schemaServices.map(async service=>{
        if(typeof images[service]!=='string'||!/^sha256:[a-f0-9]{64}$/.test(images[service]))throw new Error('Не закреплён образ схемы '+service);
        const output=await run(['run','--rm','--network','none','--read-only','--memory','256m','--pids-limit','64','--cap-drop','ALL',
            '--security-opt','no-new-privileges','--entrypoint','node',images[service],'/app/dist/database/migrate.cli.js','manifest'],{timeout:30000});
        let value;try{value=JSON.parse(output);}catch{throw new Error('Некорректная опись миграций '+service);}
        return [service,validateSchemaManifest(service,value)];
    }));
    return Object.fromEntries(entries);
}

/** Все схемы подтверждают готовность до запуска приложений; pending допустим только при check. */
export async function runSchemaCommands(client,mode,{remainingMs,beforeEach}={}){
    if(!['check','migrate'].includes(mode))throw new Error('Неизвестная команда схемы');
    const result={};
    for(const service of schemaServices){
        await beforeEach?.(service);
        const output=await client.run(['run','--rm','--no-deps','-T','--read-only','--pull','never','--entrypoint','node',
            service,'dist/database/migrate.cli.js',mode],remainingMs?{timeout:remainingMs()}:undefined);
        let receipt;try{receipt=JSON.parse(output);}catch{throw new Error('Не подтверждена готовность схемы '+service);}
        if(receipt?.ok!==true||typeof receipt.ready!=='boolean'||!Array.isArray(receipt.applied)||!Array.isArray(receipt.pending)
            ||(service!=='feature-flags-service'&&typeof receipt.existingSchema!=='boolean')
            ||(receipt.ready&&(receipt.pending.length>0||receipt.applied.length===0||service!=='feature-flags-service'&&!receipt.existingSchema))
            ||(mode==='migrate'&&(!receipt.ready||receipt.pending.length!==0)))throw new Error('Не подтверждена готовность схемы '+service);
        result[service]=receipt;
    }
    return result;
}
