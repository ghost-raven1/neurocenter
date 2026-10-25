import {BadRequestException} from '@nestjs/common';
import type {BrowserSessionIdentity,CreateBrowserSession} from './browser-auth-session.types';

const invalid=()=>new BadRequestException('Некорректные данные браузерной сессии.');
function object(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.prototype.hasOwnProperty.call(value,key)))throw invalid();
 return value as Record<string,unknown>;
}
function text(value:unknown,max:number):string{
 if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw invalid();return value;
}
export function sessionHash(value:unknown):string{
 if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw invalid();return value;
}
export function sessionIdentity(value:unknown):BrowserSessionIdentity{
 const input=object(value,['id','principalName','email','displayName']);
 const identity={id:text(input.id,512),principalName:text(input.principalName,512),email:text(input.email,320),displayName:text(input.displayName,512)};
 if(!/^[^\s@]+@[^\s@]+$/.test(identity.email)||Buffer.byteLength(JSON.stringify(identity))>8192)throw invalid();return identity;
}
export function sessionRole(value:unknown):string{return text(object(value,['selectedRole']).selectedRole,128);}
/** Reject unknown properties rather than persisting a wider user/profile payload. */
export function createSessionInput(value:unknown):CreateBrowserSession{
 const input=object(value,['tokenHash','identity','selectedRole','ttlSeconds']);
 if(typeof input.ttlSeconds!=='number'||!Number.isSafeInteger(input.ttlSeconds)||Number(input.ttlSeconds)<60||Number(input.ttlSeconds)>86400)throw invalid();
 return {tokenHash:sessionHash(input.tokenHash),identity:sessionIdentity(input.identity),selectedRole:text(input.selectedRole,128),ttlSeconds:Number(input.ttlSeconds)};
}
