import path from 'node:path';
import {modelCredentialIdentity} from '../workspace/model-credentials.mjs';
import {assertStoredModelKey,modelKeyUnavailable as unavailable} from '../workspace/model-credential-store.mjs';

/** До создания restore-томов проверяется закрытый ключ выбранной конфигурации. */
export async function productionModelKeyIdentity(directory,config,{allowMissing=false}={}){
    const configured=config.secrets?.model_credential_key?.file;
    if(typeof configured!=='string'||!configured||path.resolve(configured)!==path.resolve(directory,'secrets/model_credential_key'))throw unavailable();
    const identity=await modelCredentialIdentity(directory,{allowMissing});
    return {required:true,keyId:identity?.keyId??null};
}

/** Первое добавление секрета разрешено только пустому набору зашифрованных credentials. */
export async function assertProductionModelKey(directory,config,sql,{allowMissing=false}={}){
    const identity=await productionModelKeyIdentity(directory,config,{allowMissing});
    await assertStoredModelKey(identity.keyId,sql);
    return identity;
}
