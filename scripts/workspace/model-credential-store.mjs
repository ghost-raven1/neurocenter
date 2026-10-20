export const modelKeyUnavailable=()=>new Error('Ключ шифрования моделей не соответствует сохранённым подключениям. Восстановите исходные model_credential_key и model_credential_key.id из защищённой копии конфигурации.');

/** Only public keyId values leave PostgreSQL; no API key or ciphertext is selected. */
export async function storedModelKeyIds(sql){
    const present=(await sql("SELECT to_regclass('public.model_remote_connections') IS NOT NULL;")).trim();
    if(present==='f')return [];
    if(present!=='t')throw modelKeyUnavailable();
    let ids;try{ids=JSON.parse(await sql("SELECT coalesce(json_agg(DISTINCT credential->>'keyId'),'[]'::json) FROM model_remote_connections WHERE credential_kind='stored';"));}catch{throw modelKeyUnavailable();}
    if(!Array.isArray(ids)||ids.some(value=>typeof value!=='string'||!/^[a-f0-9]{24}$/.test(value)))throw modelKeyUnavailable();
    return ids;
}

export async function assertStoredModelKey(keyId,sql){
    if((await storedModelKeyIds(sql)).some(id=>id!==keyId))throw modelKeyUnavailable();
}
