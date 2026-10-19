import {Injectable, ServiceUnavailableException} from '@nestjs/common';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {loginReturn} from './login-return';

interface ITransaction {verifier:string; returnTo:string; expiresAt:number}

/** Одноразовая серверная транзакция связывает cookie, state, PKCE и маршрут возврата. */
@Injectable()
export class OAuthTransactions {
    private readonly pending=new Map<string,ITransaction>();

    create(returnTo:unknown):{state:string; challenge:string} {
        for(const [key,value] of this.pending){if(value.expiresAt<=Date.now()){this.pending.delete(key);}}
        if(this.pending.size>=10000){throw new ServiceUnavailableException('Слишком много незавершённых входов. Повторите позже.');}
        const state=randomBytes(32).toString('hex');const verifier=randomBytes(32).toString('base64url');
        this.pending.set(state,{verifier,returnTo:loginReturn(returnTo),expiresAt:Date.now()+600000});
        return {state,challenge:createHash('sha256').update(verifier).digest('base64url')};
    }

    consume(state:unknown,cookie:unknown):ITransaction|null {
        if(typeof state!=='string'||typeof cookie!=='string'||!/^[a-f0-9]{64}$/.test(state)||!/^[a-f0-9]{64}$/.test(cookie)) {return null;}
        if(!timingSafeEqual(Buffer.from(state),Buffer.from(cookie))){return null;}
        const transaction=this.pending.get(state);this.pending.delete(state);
        return transaction&&transaction.expiresAt>Date.now()?transaction:null;
    }
}
