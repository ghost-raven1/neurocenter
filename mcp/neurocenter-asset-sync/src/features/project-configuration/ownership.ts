import fs from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {hash} from '../../bridge/state.js';
import {InstallationLedger,LEDGER_PATH} from '../../bridge/installation-ledger.js';
import {journalDirectory,parseJournal} from '../../bridge/installation-journal.js';
import {readBoundedUtf8} from '../../bridge/read-bounded.js';
import {safeTarget} from '../../bridge/workspace.js';
import type {InstallationPlan} from '../../bridge/installation-plan.js';
import type {Receipt} from '../../bridge/installation-receipt.js';
import {readPrivateConfiguration} from '../local-configuration/private-store.js';
import {profileKey} from '../rag-hosted/profile.js';
import type {ConfigurationContext} from './context.js';
import {configurationObject,object} from './json.js';
import {OPEN_CODE_CONFIGS} from './discovery.js';
interface Protection {mcp:Set<string>;provider:Set<string>;plugins:Set<unknown>;files:Set<string>}
const damaged=()=>Error('Управляемая установка не подтверждена. Проверьте или восстановите её через сайт.');
const receiptPath=(key:string)=>'.opencode/neurocenter/receipts/'+key+'.json';
/** Local RAG access requires the frozen server reference AND the bridge-private committed receipt. */
export async function provenRag(context:ConfigurationContext,plan:InstallationPlan):Promise<boolean>{
    const refs=context.descriptor.ragInstallations;if(!refs.length)return false;
    await InstallationLedger.load(plan);const ledger=JSON.parse((await plan.read(LEDGER_PATH))??'{}') as {roots?:Record<string,{packages:Array<{key:string;version:number;manifest:string}>}>};
    const history=path.join(journalDirectory(context.root),'history'),names=(await fs.readdir(history).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;})).filter(name=>/^[-a-f0-9]{36}\.json$/.test(name));
    if(names.length>1000)throw Error('Слишком много журналов. Восстановите установку перед открытием RAG.');
    let total=0;const proofs=new Map<string,string>();
    for(const ref of refs){const key=hash(ref.kind+':'+ref.id).slice(0,24),raw=await plan.read(receiptPath(key));if(raw===null||!Object.values(ledger.roots??{}).some(root=>root.packages.some(item=>item.key===key&&item.version===ref.version&&item.manifest===ref.manifest)))throw damaged();
        let receipt:Receipt;try{receipt=JSON.parse(raw) as Receipt;if(receipt.version!==ref.version||receipt.manifest!==ref.manifest||!object(receipt.files))throw damaged();}catch{throw damaged();}proofs.set(key,raw);
    }
    for(const name of names){if(!proofs.size)break;const raw=await readBoundedUtf8(path.join(history,name),32*1024*1024);total+=Buffer.byteLength(raw);if(total>64*1024*1024)throw Error('Превышен лимит проверки журналов RAG. Проверьте установку через сайт.');const journal=parseJournal(raw,context.root);
        if(journal.state!=='committed'||journal.action!=='install'||journal.result?.projectId!==context.descriptor.projectId||journal.result?.bindingId!==context.descriptor.bindingId)continue;
        for(const [key,receipt] of proofs){const ref=refs.find(item=>hash(item.kind+':'+item.id).slice(0,24)===key)!;
            const pinned=journal.result.assetId===ref.id&&journal.result.version===ref.version&&journal.result.manifest===ref.manifest||Array.isArray(journal.result.packages)&&journal.result.packages.some(item=>isDeepStrictEqual(item,ref));
            if(pinned&&journal.changes.some(change=>change.relative===receiptPath(key)&&!change.encoding&&change.after===receipt))proofs.delete(key);
        }
    }
    if(proofs.size)throw damaged();return true;
}
/** Protect canonical connection entries while allowing unrelated manual JSONC changes. */
export async function managedProtection(context:ConfigurationContext,plan:InstallationPlan):Promise<Protection>{
    const protection:Protection={mcp:new Set(),provider:new Set(),plugins:new Set(),files:new Set()};
    const directory=await safeTarget(context.root,'.opencode/neurocenter/receipts');
    const names=await fs.readdir(directory).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;});if(names.length>1000)throw damaged();
    let receiptBytes=0;
    for(const name of names.filter(name=>/^[a-f0-9]{24}\.json$/.test(name))){const raw=await plan.read('.opencode/neurocenter/receipts/'+name);if(raw===null||(receiptBytes+=Buffer.byteLength(raw))>4*1024*1024)throw damaged();const receipt=JSON.parse(raw) as Receipt;
        if(receipt.config?.key==='plugin')protection.plugins.add(receipt.config.value);else if(receipt.config?.key)protection.mcp.add(receipt.config.key);
        for(const file of Object.keys(receipt.files??{}))protection.files.add(file);
    }
    const providers=await safeTarget(context.root,'.opencode/neurocenter/providers'),providerNames=await fs.readdir(providers).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;});if(providerNames.length>100)throw damaged();
    for(const name of providerNames.filter(name=>/^[-a-zA-Z0-9_.]+\.json$/.test(name))){const raw=await plan.read('.opencode/neurocenter/providers/'+name);if(raw===null)throw damaged();const receipt=JSON.parse(raw) as {providerId?:unknown;plugin?:unknown;files?:Array<{relative:string}>};if(typeof receipt.providerId!=='string')throw damaged();protection.provider.add(receipt.providerId);if(receipt.plugin)protection.plugins.add(receipt.plugin);for(const file of receipt.files??[])protection.files.add(file.relative);}
    return protection;
}
export async function hasManagedRagProfile(context:ConfigurationContext):Promise<boolean>{return await readPrivateConfiguration(profileKey(context.site,context.root,context.descriptor.instanceId))!==undefined;}
export function assertManualFile(relative:string,protection:Protection){
    if(protection.files.has(relative)||/^\.opencode\/(agents?|modes?)\/(?:[^/]+\/)*nc-[^/]+\.md$/i.test(relative)||relative.startsWith('.opencode/plugins/neurocenter-'))throw Error('Этот файл принадлежит настройкам сайта. Измените агента или подключение в Neurocenter.');
}
export async function preserveConnections(plan:InstallationPlan,relative:string,before:string|null,after:string,protection:Protection){
    const previous=configurationObject(before),next=configurationObject(after);
    for(const section of ['mcp','provider','agent','mode'] as const){const old=object(previous[section])?previous[section]:{},value=object(next[section])?next[section]:{};
        const owned=new Set([...Object.keys(old),...Object.keys(value)].filter(key=>key.startsWith('nc-')||key.startsWith('neurocenter-')||key.startsWith('neurocenter_')));
        for(const key of section==='mcp'?protection.mcp:section==='provider'?protection.provider:[])owned.add(key);
        for(const key of owned)if(!isDeepStrictEqual(old[key],value[key]))throw Error('Управляемые агенты и подключения изменяются через сайт. Остальные поля доступны в редакторе.');
    }
    for(const managed of protection.plugins){const count=(value:unknown)=>Array.isArray(value)?value.filter(item=>isDeepStrictEqual(item,managed)).length:0;if(count(previous.plugin)!==count(next.plugin))throw Error('Управляемый плагин изменяется через сайт.');}
    // Adding an override in another project layer must not shadow the canonical site entry.
    for(const other of OPEN_CODE_CONFIGS){if(other===relative)continue;const raw=await plan.read(other);if(raw===null)continue;const value=configurationObject(raw);
        for(const section of ['mcp','provider'] as const){const entries=object(value[section])?value[section]:{},was=object(previous[section])?previous[section]:{},now=object(next[section])?next[section]:{};
            for(const key of section==='mcp'?protection.mcp:protection.provider)if(entries[key]!==undefined&&was[key]===undefined&&now[key]!==undefined)throw Error('Подключение уже управляется другим файлом проекта.');}
    }
}
