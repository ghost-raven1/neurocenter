import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {parse,parseTree,modify,applyEdits,type ParseError,type Node} from 'jsonc-parser';
import {InstallationPlan} from '../../bridge/installation-plan.js';
import {withProjectFiles,commitChanges} from '../../bridge/installation-files.js';
import {readOpenCodeModelMetadata} from '../../bridge/opencode-model-scan.js';
import {hasUnsafeOpenCodeWarnings as unsafeScan} from '../../bridge/opencode-scan-warnings.js';
import {createProviderCredential,providerCredentialPresent} from './credential.js';
import {providerReportIdentity,type OpenCodeProviderStatus} from './contract.js';
import {type ProviderContext,type Authorize,stale} from './context.js';
import {providerConfig,providerProof,receiptFile,journalKey,conflict,type ProviderReceipt} from './receipt.js';
import {resolveConnector,codexDefinition} from './connector.js';
import {ollamaAdapterUrl} from './ollama-entry.js';
import {jobContext} from '../../bridge/state.js';
import type {IOpenCodeModelCandidate} from '../../../../../services/shared/opencode-model-scan.cjs';
/** Local OAuth is expected only after the owned receipt, wrapper and immutable connector have been verified. */
function matchesOwnedCodex(candidates:IOpenCodeModelCandidate[],models:string[]):boolean{
    const candidate=candidates[0];
    return candidates.length===1&&models.length===1&&!!candidate&&candidate.blocker==='codex-local-auth'
        &&candidate.runtime==='remote-openai'&&candidate.model===models[0]&&candidate.baseUrl==='https://chatgpt.com/backend-api/codex';
}
const duplicate=(node:Node|undefined):boolean=>!!node&&((node.type==='object'&&new Set(node.children?.map(child=>child.children?.[0]?.value)).size!==node.children?.length)||!!node.children?.some(duplicate));
function config(raw:string|null):Record<string,unknown>{
    const errors:ParseError[]=[],value:unknown=parse(raw??'{}',errors,{allowTrailingComma:true});
    if(errors.length||!value||typeof value!=='object'||Array.isArray(value)||duplicate(parseTree(raw??'{}')))throw conflict();return value as Record<string,unknown>;
}
function entry(context:ProviderContext,credentialFile:string):Record<string,unknown>{
    const expectations=context.descriptor.expectations;
    if(!expectations)throw new Error('Адаптер провайдера недоступен.');
    const {contextWindow,...basic}=expectations.options;
    const ollama=context.descriptor.providerKind==='ollama',generation=ollama?expectations.options:basic;
    const output=ollama?expectations.options.maxOutputTokens:undefined;
    return {
        npm:ollama?ollamaAdapterUrl:'@ai-sdk/openai-compatible',name:ollama?'Ollama':'Neurocenter',
        options:{baseURL:expectations.baseUrl,...(credentialFile?{apiKey:'{file:'+credentialFile+'}'}:{})},
        models:{[expectations.runtimeModel]:{
            name:expectations.runtimeModel,id:expectations.runtimeModel,
            ...(expectations.capability==='vision'?{modalities:{input:['text','image'],output:['text']}}:{}),
            ...(Object.keys(generation).length?{options:generation}:{}),
            ...(contextWindow||output?{limit:{...(contextWindow?{context:contextWindow}:{}),...(output?{output}:{})}}:{}),
        }},
    };
}
async function observed(context:ProviderContext,authorize:Authorize,credentialTarget?:Record<string,string>,providerNamespaceTarget?:Set<string>,providerPluginTarget?:Array<{identity:string;plain:boolean}>){const d=context.descriptor;return readOpenCodeModelMetadata(context.root,{scope:'project',projectId:d.projectId,bindingId:d.bindingId,instanceId:d.instanceId},{authorize,readAuth:d.providerKind==='ollama',credentialTarget,allowManagedCredentialRead:!!credentialTarget,providerNamespaceTarget,providerPluginTarget});}
/** Used by the per-request managed connector permit without executing a model or re-authenticating. */
export async function assertOwnedProvider(context:ProviderContext){
    const proof=await providerProof(context);if(!proof||proof.receipt.schemaDigest!==context.descriptor.schemaDigest)throw conflict();
    const plan=new InstallationPlan(context.root),value=config(await plan.read(providerConfig)),providers=value.provider as Record<string,unknown>|undefined;
    if(await plan.read(receiptFile(context.descriptor.providerId))!==proof.raw||!isDeepStrictEqual(providers?.[context.descriptor.providerId],proof.receipt.entry))throw conflict();
    for(const file of proof.receipt.files??[])if(await plan.read(file.relative)!==file.content)throw conflict();
    if(proof.receipt.plugin&&(!Array.isArray(value.plugin)||value.plugin.filter(item=>item===proof.receipt.plugin).length!==1))throw conflict();
    if(context.descriptor.providerKind==='codex-bridge'){const plugins:Array<{identity:string;plain:boolean}>=[],scan=await observed(context,async()=>{await context.assertCurrent();},undefined,undefined,plugins),candidates=scan.candidates.filter(c=>c.provider===context.descriptor.providerId),models=Object.keys(proof.receipt.entry.models as Record<string,unknown>);
        if(unsafeScan(scan.warnings)||!matchesOwnedCodex(candidates,models)||!plugins.filter(item=>item.identity===proof.receipt.plugin).at(-1)?.plain)throw conflict();}
    await context.assertCurrent();return proof;
}
/** Readback checks the effective known OpenCode layers, without executing plugins or inference. */
export async function providerStatus(context:ProviderContext,authorize:Authorize):Promise<OpenCodeProviderStatus>{
    await context.assertCurrent();await authorize();const d=context.descriptor;
    const result=(state:OpenCodeProviderStatus['state'],missingFields:OpenCodeProviderStatus['missingFields']=[],revision:string|null=null):OpenCodeProviderStatus=>({...providerReportIdentity(d),state,ready:state==='configured',missingFields,revision,checkedAt:new Date().toISOString()});
    if(d.providerKind==='codex-bridge'){
        let proof;try{proof=await providerProof(context);if(!proof)return result('missing',['login']);await assertOwnedProvider(context);
            const scan=await observed(context,authorize),expected=Object.keys(proof.receipt.entry.models as Record<string,unknown>),candidate=scan.candidates.filter(c=>c.provider===d.providerId);
            if(unsafeScan(scan.warnings)||!matchesOwnedCodex(candidate,expected))return result('conflict',[],proof.receipt.revision);
            await resolveConnector(context);return result('configured',[],proof.receipt.revision);
        }catch(error){if((error as {code?:string}).code==='CODEX_LOGIN_REQUIRED')return result('login-required',['login'],proof?.receipt.revision??null);return result(proof?'conflict':'unavailable',[],proof?.receipt.revision??null);}
    }
    const proof=await providerProof(context),credentials:Record<string,string>={},scan=await observed(context,authorize,credentials);
    if(unsafeScan(scan.warnings))return result('unavailable');
    if(!proof)return result(scan.candidates.some(c=>c.provider===d.providerId)?'conflict':'missing',d.providerKind==='ollama'?[]:['credential']);
    const plan=new InstallationPlan(context.root),raw=await plan.read(receiptFile(d.providerId)),value=config(await plan.read(providerConfig));
    const providers=value.provider as Record<string,unknown>|undefined;
    if(raw!==proof.raw||!isDeepStrictEqual(providers?.[d.providerId],proof.receipt.entry)||proof.receipt.schemaDigest!==d.schemaDigest)return result('conflict',[],proof.receipt.revision);
    const e=d.expectations!,matches=scan.candidates.filter(c=>c.provider===d.providerId);
    const candidate=matches[0],localOllama=d.providerKind==='ollama'&&candidate?.blocker==='device-local-endpoint';
    if(matches.length!==1||candidate?.blocker&&!localOllama||candidate?.runtime!==(d.providerKind==='ollama'?'remote-ollama':'remote-openai')||candidate?.model!==e.runtimeModel||candidate?.baseUrl!==e.baseUrl||candidate?.capability!==e.capability||!isDeepStrictEqual(candidate?.options??{},e.options))return result('conflict');
    if(d.providerKind==='ollama'&&!proof.receipt.credentialFile){if(candidate.hasKey)return result('conflict');await context.assertCurrent();return result('configured',[],proof.receipt.revision);}
    if(!await providerCredentialPresent(proof.receipt.credentialFile))return result('missing',['credential'],proof.receipt.revision);
    if(!credentials[matches[0]!.candidateId]||!await providerCredentialPresent(proof.receipt.credentialFile,credentials[matches[0]!.candidateId]))return result('conflict');
    await context.assertCurrent();return result('configured',[],proof.receipt.revision);
}
/** Save only the owned provider entry, with the existing project transaction, CAS and recovery journal. */
export async function saveProvider(context:ProviderContext,key:unknown,expectedRevision:string|null,authorizeSave:Authorize,beforeCommit:()=>void=()=>{},session?:{preparationId:string;setupJobId:string},signal?:AbortSignal):Promise<OpenCodeProviderStatus>{
    // The wizard outlives the opening job; later saves own a file journal, never its completion.
    return jobContext.exit(()=>withProjectFiles(context.descriptor.projectId,async root=>{
        if(root!==context.root)throw stale();await context.assertCurrent();await authorizeSave();beforeCommit();
        const proof=await providerProof(context);if((proof?.receipt.revision??null)!==expectedRevision)throw conflict();
        const plan=new InstallationPlan(root),raw=await plan.read(providerConfig),value=config(raw),receiptRaw=await plan.read(receiptFile(context.descriptor.providerId));
        const providers=value.provider as Record<string,unknown>|undefined;if(value.provider!==undefined&&(!providers||Array.isArray(providers)||typeof providers!=='object'))throw conflict();
        const current=providers?.[context.descriptor.providerId];
        if(proof?(receiptRaw!==proof.raw||!isDeepStrictEqual(current,proof.receipt.entry)):receiptRaw!==null||current!==undefined)throw conflict();
        if(proof)await assertOwnedProvider({...context,descriptor:{...context.descriptor,schemaDigest:proof.receipt.schemaDigest}});
        const namespace=new Set<string>(),scan=await observed(context,async()=>{await context.assertCurrent();},undefined,namespace);
        if(unsafeScan(scan.warnings)||!proof&&namespace.has(context.descriptor.providerId))throw conflict();
        const codex=context.descriptor.providerKind==='codex-bridge';if(codex&&!session)throw stale();
        const ollama=context.descriptor.providerKind==='ollama',definition=codex?await codexDefinition(context,key,session!,signal):undefined;
        const credentialFile=codex||ollama&&(key===null||key===undefined&&!proof)?'':key===undefined&&proof?proof.receipt.credentialFile:await createProviderCredential(key);
        if(!codex&&(!ollama||credentialFile)&&!await providerCredentialPresent(credentialFile))throw new Error('Введите ключ провайдера локально.');
        const desired=definition?.entry??entry(context,credentialFile),receipt:ProviderReceipt={schemaVersion:1,revision:randomUUID(),schemaDigest:context.descriptor.schemaDigest,projectId:context.descriptor.projectId,
            bindingId:context.descriptor.bindingId,instanceId:context.descriptor.instanceId,providerId:context.descriptor.providerId,entry:desired,credentialFile};
        let updated=applyEdits(raw??'{}\n',modify(raw??'{}\n',['provider',context.descriptor.providerId],desired,{formattingOptions:{insertSpaces:true,tabSize:2}}));
        if(definition){
            const plugins=value.plugin??[];if(!Array.isArray(plugins))throw conflict();
            if(!proof&&plugins.includes(definition.plugin))throw conflict();
            for(const file of definition.files){const before=await plan.read(file.relative);if(proof?before!==proof.receipt.files?.find(item=>item.relative===file.relative)?.content:before!==null)throw conflict();await plan.write(file.relative,file.content);}
            updated=applyEdits(updated,modify(updated,['plugin'],[...plugins.filter(item=>item!==proof?.receipt.plugin),definition.plugin],{formattingOptions:{insertSpaces:true,tabSize:2}}));receipt.files=definition.files;receipt.plugin=definition.plugin;receipt.authorization=session;
        }
        await plan.write(providerConfig,updated);await plan.write(receiptFile(context.descriptor.providerId),JSON.stringify(receipt,null,2)+'\n');
        const verify=async()=>{await authorizeSave();await context.assertCurrent();beforeCommit();await plan.verifySnapshot();};
        await commitChanges(root,plan.changes(),{action:'install',assetKey:journalKey(context),manifest:context.descriptor.schemaDigest,result:providerReportIdentity(context.descriptor) as unknown as Record<string,unknown>},{verifySnapshot:verify});
        return providerStatus(context,async()=>{await context.assertCurrent();});
    }));
}
