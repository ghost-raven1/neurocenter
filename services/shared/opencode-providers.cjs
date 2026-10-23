'use strict';

const OPENCODE_PROVIDER_CAPABILITY='opencode-providers-v1';
const OPENCODE_OLLAMA_CAPABILITY='opencode-ollama-v1';
const OPENCODE_PROVIDER_JOBS=['prepare-opencode-provider','open-opencode-provider','get-opencode-provider-status'];
const KINDS=['openai-compatible','ollama','codex-bridge'];
const SHA=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=()=>{throw new Error('Некорректный контекст локального провайдера OpenCode.');};
const safeText=(value,maximum)=>typeof value==='string'&&value.length>0&&value.length<=maximum&&!/[\x00-\x20\x7f]/.test(value)&&!value.includes('://');
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const canonical=value=>Array.isArray(value)?value.map(canonical):record(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const descriptorKeys=['schemaVersion','deviceId','projectId','bindingId','instanceId','providerKind','providerId','schemaDigest','expectations','connector'];

/** Only the authorized device receives the credential-free endpoint; reports project it out. */
function normalizeProviderDescriptor(value){
    if(!exact(value,descriptorKeys)||value.schemaVersion!==1||!UUID.test(value.deviceId)||typeof value.deviceId!=='string'
        ||typeof value.projectId!=='string'||!/^prj-[a-zA-Z0-9-]{1,235}$/.test(value.projectId)||typeof value.bindingId!=='string'||!SHA.test(value.bindingId)
        ||typeof value.instanceId!=='string'||!UUID.test(value.instanceId)||!KINDS.includes(value.providerKind)
        ||typeof value.providerId!=='string'||!/^neurocenter-(?:openai|ollama|codex)-[a-f0-9]{16}$/.test(value.providerId)
        ||typeof value.schemaDigest!=='string'||!SHA.test(value.schemaDigest))fail();
    let expectations=null,connector=null;
    if(value.providerKind!=='codex-bridge'){
        const item=value.expectations;
        if(value.connector!==null||!exact(item,['catalogModelId','modelPin','runtimeModel','capability','baseUrl','options'])
            ||!safeText(item.catalogModelId,128)||!item.catalogModelId.startsWith('model-')||typeof item.modelPin!=='string'||!SHA.test(item.modelPin)
            ||!safeText(item.runtimeModel,128)||!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(item.runtimeModel)||!['chat','vision'].includes(item.capability)||!record(item.options))fail();
        let endpoint;try{endpoint=new URL(item.baseUrl);}catch{fail();}
        if(typeof item.baseUrl!=='string'||item.baseUrl.length>2048||!['https:','http:'].includes(endpoint.protocol)||endpoint.username||endpoint.password
            ||endpoint.search||endpoint.hash||endpoint.href.replace(/\/+$/,'')!==item.baseUrl)fail();
        const options={};
        for(const key of Object.keys(item.options).sort()){
            const n=item.options[key];
            if(!['temperature','topP','maxOutputTokens','contextWindow'].includes(key)||typeof n!=='number'||!Number.isFinite(n)
                ||key==='temperature'&&(n<0||n>2)||key==='topP'&&(n<0||n>1)
                ||key==='maxOutputTokens'&&(!Number.isSafeInteger(n)||n<1||n>32768)
                ||key==='contextWindow'&&(!Number.isSafeInteger(n)||n<128||n>2097152))fail();
            options[key]=n;
        }
        expectations={catalogModelId:item.catalogModelId,modelPin:item.modelPin,runtimeModel:item.runtimeModel,capability:item.capability,baseUrl:item.baseUrl,options};
    }else{
        const item=value.connector;
        if(value.expectations!==null||!exact(item,['assetId','version','manifest','sourceCommit'])||!safeText(item.assetId,128)
            ||!Number.isSafeInteger(item.version)||item.version<1||typeof item.manifest!=='string'||!SHA.test(item.manifest)
            ||typeof item.sourceCommit!=='string'||!/^[a-f0-9]{40}$/.test(item.sourceCommit))fail();
        connector={assetId:item.assetId,version:item.version,manifest:item.manifest,sourceCommit:item.sourceCommit};
    }
    if(!value.providerId.startsWith('neurocenter-'+(value.providerKind==='codex-bridge'?'codex':value.providerKind==='ollama'?'ollama':'openai')+'-'))fail();
    return {schemaVersion:1,deviceId:value.deviceId,projectId:value.projectId,bindingId:value.bindingId,instanceId:value.instanceId,
        providerKind:value.providerKind,providerId:value.providerId,schemaDigest:value.schemaDigest,expectations,connector};
}

/** Stable non-secret identity is the entire permitted server-bound report context. */
function providerReportIdentity(value){
    const {expectations,...descriptor}=normalizeProviderDescriptor(value);
    return {...descriptor,catalogModelId:expectations?.catalogModelId??null,modelPin:expectations?.modelPin??null};
}

/** A report is only public readiness; successful installation does not assert paid inference. */
function normalizeProviderReport(kind,value,descriptor,failed=false,preparationId){
    const source=providerReportIdentity(descriptor),keys=Object.keys(source);
    if(!OPENCODE_PROVIDER_JOBS.includes(kind))fail();
    if(failed){if(!exact(value,[]))fail();return {};}
    const tail=kind==='prepare-opencode-provider'?['preparationId','expiresAt']:kind==='open-opencode-provider'?['preparationId','opened','expiresAt']
        :['state','ready','missingFields','revision','checkedAt'];
    if(!exact(value,[...keys,...tail])||keys.some(key=>JSON.stringify(canonical(value[key]))!==JSON.stringify(canonical(source[key]))))fail();
    if(kind==='get-opencode-provider-status'){
        if(!['missing','configured','login-required','unavailable','conflict'].includes(value.state)||typeof value.ready!=='boolean'
            ||!Array.isArray(value.missingFields)||value.missingFields.length>3||new Set(value.missingFields).size!==value.missingFields.length
            ||value.missingFields.some(key=>!['baseUrl','credential','login'].includes(key))||value.ready!==(value.state==='configured')
            ||value.ready&&value.missingFields.length>0||value.revision!==null&&(typeof value.revision!=='string'||!UUID.test(value.revision))
            ||!iso(value.checkedAt)||Date.parse(value.checkedAt)>Date.now()+60000)fail();
        return {...source,state:value.state,ready:value.ready,missingFields:[...value.missingFields],revision:value.revision,checkedAt:value.checkedAt};
    }
    if(typeof value.preparationId!=='string'||!UUID.test(value.preparationId)||!iso(value.expiresAt)||Date.parse(value.expiresAt)>Date.now()+16*60000
        ||kind==='open-opencode-provider'&&(value.opened!==true||value.preparationId!==preparationId))fail();
    return {...source,preparationId:value.preparationId,...kind==='open-opencode-provider'?{opened:true}:{},expiresAt:value.expiresAt};
}
module.exports={OPENCODE_PROVIDER_CAPABILITY,OPENCODE_OLLAMA_CAPABILITY,OPENCODE_PROVIDER_JOBS,normalizeProviderDescriptor,providerReportIdentity,normalizeProviderReport};
