import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import {createHash,createPrivateKey,createPublicKey,sign,verify,type KeyObject} from 'node:crypto';
import {ServiceUnavailableException,ConflictException} from '@nestjs/common';
import {snapshotCanonicalJson} from '../../../shared/project-snapshot.cjs';
import type {SnapshotSignature} from './snapshot-types';

/** One configured Ed25519 identity signs both full images and release capsules. */
export class SnapshotSigner {
    constructor(private readonly filename=process.env.SNAPSHOT_SIGNING_KEY_FILE){}
    private async privateKey():Promise<KeyObject>{
        if(!this.filename)throw new ServiceUnavailableException('Настройте приватный ключ подписи снимков.');
        const file=await fs.open(this.filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try{
            const stat=await file.stat();
            if(!stat.isFile()||stat.nlink!==1||stat.size>8192||(stat.mode&0o077)!==0)throw new ServiceUnavailableException('Приватный ключ снимков должен быть обычным закрытым файлом.');
            const bytes=await file.readFile(),after=await file.stat();if(bytes.length!==stat.size||after.ino!==stat.ino||after.mtimeMs!==stat.mtimeMs)throw new ServiceUnavailableException('Ключ снимков изменился во время чтения.');
            const key=createPrivateKey(bytes);if(key.asymmetricKeyType!=='ed25519')throw new ServiceUnavailableException('Для снимков нужен ключ Ed25519.');return key;
        }finally{await file.close();}
    }
    async signature(value:unknown):Promise<SnapshotSignature>{
        const key=await this.privateKey(),publicKey=createPublicKey(key).export({type:'spki',format:'pem'}).toString();
        return {algorithm:'Ed25519',keyId:createHash('sha256').update(publicKey).digest('hex'),publicKey,
            value:sign(null,Buffer.from(snapshotCanonicalJson(value)),key).toString('base64')};
    }
    async verify(value:unknown,signature:SnapshotSignature):Promise<void>{
        const identity=await this.signature({purpose:'identity'});
        const trusted:Record<string,string>={[identity.keyId]:identity.publicKey};
        if(process.env.SNAPSHOT_TRUSTED_KEYS_FILE){
            const file=await fs.open(process.env.SNAPSHOT_TRUSTED_KEYS_FILE,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
            try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>65536)throw new ServiceUnavailableException('Файл доверенных ключей повреждён.');
                try{const old=JSON.parse(await file.readFile('utf8')) as Record<string,string>;
                    if(!old||typeof old!=='object'||Array.isArray(old))throw new Error();
                    for(const [id,pem] of Object.entries(old)){if(typeof pem!=='string'||createHash('sha256').update(pem).digest('hex')!==id||createPublicKey(pem).asymmetricKeyType!=='ed25519')throw new Error();trusted[id]=pem;}
                }catch{throw new ServiceUnavailableException('Файл доверенных ключей повреждён.');}
            }finally{await file.close();}
        }
        try{if(!signature||signature.algorithm!=='Ed25519'||trusted[signature.keyId]!==signature.publicKey
            ||!verify(null,Buffer.from(snapshotCanonicalJson(value)),createPublicKey(signature.publicKey),Buffer.from(signature.value,'base64')))throw new Error();}
        catch{throw new ConflictException('Подпись снимка или ключ площадки изменились.');}
    }
}
