import fs from 'node:fs/promises';
import path from 'node:path';
import {createRagContext,checkedWorkspacePath} from './rag-context.mjs';
import {DEFAULT_CONFIG,findConfigFile,loadConfig} from './upstream/dist/core/config.js';
import {managedRagConfiguration,readProjectRagConfiguration} from './rag-plugin-config.mjs';
import {runIndexPass} from './upstream/dist/indexer/pipeline.js';
import {destroyAllPooledConnections} from './upstream/dist/embedder/http.js';
import {protectedEmbedder,requireSuccessfulIndex} from './rag-errors.mjs';
import {embeddingSignature,normalizeIndexProfile} from './rag-index-contract.cjs';
import {reindexSourceSnapshot} from './rag-reindex-source.mjs';

/** Only this explicit candidate command replaces a stale connection; ordinary startup keeps its exact-grant checks. */
async function candidateConfiguration(root,input,profile){
    const source=findConfigFile(root);if(source)await checkedWorkspacePath(root,source);
    const raw=readProjectRagConfiguration(source),embedding={provider:profile.provider,model:profile.model,vectorDimension:profile.dimension,baseUrl:input.baseUrl,apiKey:input.apiKey,timeoutMs:120000};
    // No root is passed until the candidate is committed: the previous private grant belongs to the active index.
    const config=managedRagConfiguration(source?loadConfig(source):structuredClone(DEFAULT_CONFIG),{...raw,embedding});
    config.embedding={...config.embedding,...embedding};config.openCode={...config.openCode,autoIndex:{...config.openCode?.autoIndex,enabled:false}};
    config.indexing={...config.indexing,embedBatchSize:8,embedConcurrency:1};
    for(const name of ['description','imageDescription','decision','reranking'])config[name]={...config[name],enabled:false};
    return config;
}

/** Bridge builds an isolated candidate; this command never swaps or rewrites the active store. */
export async function buildManagedReindex(stage,raw){
    const input=JSON.parse(raw),profile=normalizeIndexProfile(input.profile),url=new URL(input.baseUrl);
    if(Object.keys(input).sort().join(',')!=='apiKey,baseUrl,profile'||profile?.provider!=='openai'||profile.dimension>16000||!/^neurocenter\/[A-Za-z0-9._-]+\/sha256\/[a-f0-9]{64}$/.test(profile.model)
        ||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/v1'||url.search||url.hash||url.username||url.password||!Number(url.port)
        ||typeof input.apiKey!=='string'||!/^[a-f0-9]{64}$/.test(input.apiKey))throw new Error('Не подтверждено приватное подключение кандидата.');
    const root=await fs.realpath(process.cwd()),config=await candidateConfiguration(root,input,profile),active=await checkedWorkspacePath(root,config.vectorStore.path);
    stage=await checkedWorkspacePath(root,stage);
    if(path.dirname(stage)!==path.dirname(active)||!/^\.neurocenter-rag-restore-[A-Za-z0-9]{6}$/.test(path.basename(stage))
        ||(await fs.lstat(stage)).isSymbolicLink()||(await fs.readdir(stage)).length)throw new Error('Нужен новый изолированный каталог индекса.');
    try{const quirks=path.join(active,'quirks.jsonl'),stat=await fs.lstat(quirks);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024**2)throw new Error('Некорректный журнал знаний.');await fs.copyFile(quirks,path.join(stage,'quirks.jsonl'),1);}catch(error){if(error.code!=='ENOENT')throw error;}
    config.vectorStore={...config.vectorStore,path:stage};config.logging={...config.logging,level:'none'};
    config.indexing={...config.indexing,excludeDirs:[...config.indexing.excludeDirs,path.relative(root,active).split(path.sep).join('/'),'.neurocenter-rag-restore-*']};
    const marker=Symbol.for('neurocenter.hosted-rag');delete config[marker];Object.defineProperty(config,marker,{value:embeddingSignature(profile,input.baseUrl),enumerable:true,configurable:true});
    const source=await reindexSourceSnapshot(root,config);
    let context;
    try{
        context=await createRagContext(root,config);context.embedder=protectedEmbedder(context.embedder);
        const stats=requireSuccessfulIndex(await runIndexPass({cwd:root,storePath:stage,config,store:context.store,embedder:context.embedder,keywordIndex:context.keywordIndex,dimension:profile.dimension}));
        if(stats.skipped||stats.extractionFailures||stats.descriptionFailedFiles)throw new Error('Новый индекс построен не полностью.');
        if(await reindexSourceSnapshot(root,config)!==source)throw new Error('Исходные файлы изменились во время переиндексации. Прежний индекс сохранён.');
        return {complete:true,dimension:profile.dimension,rowCount:await context.store.count()};
    }finally{if(context){await context.store.close();context.keywordIndex.close();}destroyAllPooledConnections();}
}
