import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {configurationObject} from '../project-configuration/json.js';
import {snapshot,publish,conflict,type LocalSnapshot} from './files.js';
export interface ProviderChange {before:LocalSnapshot;after:string}
export interface ProviderIntent {schemaVersion:1;id:string;providerId:string;phase:'pending'|'complete';changes:ProviderChange[]}
/** Secret snapshots stay in a private local intent; public jobs never carry this record or its digest. */
export class ProviderTransactions {
    private readonly file:string;private readonly maximum:number;
    constructor(home:string,environment:NodeJS.ProcessEnv,private readonly targets:string[],private readonly fileBytes:number,private readonly authorize:()=>Promise<unknown>){
        this.file=path.join(environment.XDG_STATE_HOME||path.join(home,'.local/state'),'neurocenter','opencode-global-providers','intent.json');this.maximum=fileBytes*5+4096;
    }
    private validate(raw:Record<string,unknown>):ProviderIntent{
        const value=raw as unknown as ProviderIntent;
        if(value.schemaVersion!==1||typeof value.id!=='string'||!/^[a-f0-9-]{36}$/.test(value.id)||typeof value.providerId!=='string'||!['pending','complete'].includes(value.phase)
            ||!Array.isArray(value.changes)||!value.changes.length||value.changes.length>2||new Set(value.changes.map(item=>item.before.file)).size!==value.changes.length)throw conflict();
        for(const item of value.changes)if(!item.before||!this.targets.includes(item.before.file)||typeof item.before.secret!=='boolean'||item.before.text!==null&&typeof item.before.text!=='string'||typeof item.after!=='string'
            ||Buffer.byteLength(item.after)>this.fileBytes||item.before.text!==null&&Buffer.byteLength(item.before.text)>this.fileBytes)throw conflict();return value;
    }
    async read(){const before=await snapshot(this.file,this.maximum,true);return{before,intent:before.text===null?undefined:this.validate(configurationObject(before.text,true))};}
    private async write(intent:ProviderIntent,before:LocalSnapshot){
        const text=JSON.stringify(intent);if(Buffer.byteLength(text)>this.maximum)throw conflict();
        await publish(before,text,this.maximum,this.authorize,async()=>{const current=await snapshot(this.file,this.maximum,true);if(current.fingerprint!==before.fingerprint||current.text!==before.text)throw conflict();});
    }
    async inspect(){
        const record=await this.read();if(!record.intent)return undefined;
        const states=[];
        for(const item of record.intent.changes){const current=await snapshot(item.before.file,this.fileBytes,item.before.secret);states.push(current.text===item.after?'after':current.text===item.before.text?'before':'conflict');}
        const status=states.every(item=>item==='after')?'saved':states.includes('conflict')?'conflict':states.every(item=>item==='before')?'not-applied':'partial';
        return{intentId:record.intent.id,providerId:record.intent.providerId,status};
    }
    async begin(providerId:string,changes:ProviderChange[]){
        const previous=await this.read(),status=await this.inspect();if(status&&status.status!=='saved')throw conflict();
        const intent:ProviderIntent={schemaVersion:1,id:randomUUID(),providerId,phase:'pending',changes};await this.write(intent,previous.before);return intent;
    }
    async complete(id:string){const previous=await this.read();if(previous.intent?.id!==id||(await this.inspect())?.status!=='saved')throw conflict();await this.write({...previous.intent,phase:'complete'},previous.before);}
}
