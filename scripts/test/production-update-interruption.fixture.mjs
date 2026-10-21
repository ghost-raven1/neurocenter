import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {applicationServices} from '../production/compose-client.mjs';
import {updateProduction} from '../production/update.mjs';
import {volumeKeys} from '../production/recovery-files.mjs';
import {writeManifest} from '../production/recovery-manifest.mjs';

/** Изолированный процесс: до реального SIGTERM доходит с сохранённой applying-квитанцией. */
process.once('message',async options=>{
    const {plan}=options;
    const deps={
        composeClient:config=>({...config,run:async args=>{
            if(args[0]==='run'){return JSON.stringify({ok:true,ready:true,existingSchema:true,applied:[0,1],pending:[]});}
            if(args[0]==='up'){setInterval(()=>{},1000);process.send({phase:'applying'});await new Promise(()=>{});}
            return '';
        }}),
        composeConfiguration:async client=>({services:Object.fromEntries([...applicationServices,'postgres'].map(service=>[service,{image:service==='postgres'?'postgres':(client.release?'target':'source')+':'+service}])),secrets:{model_credential_key:{file:path.join(options.directory,'secrets/model_credential_key')}}}),
        serviceImageIds:async config=>config.services.frontend.image.startsWith('target')?plan.targetImages:plan.sourceImages,
        containers:async()=>[...applicationServices,'postgres'].map(service=>({Id:service,Image:service==='postgres'?plan.postgresImage:plan.sourceImages[service],Config:{Labels:{'com.docker.compose.service':service}},State:{Running:true,Health:{Status:'healthy'}}})),
        docker:async(args,settings)=>{
            if(args[0]==='run'){
                const service=['catalog-service','feature-flags-service','rag-sync-service'].find(name=>args.includes(plan.targetImages[name]));
                return JSON.stringify(service==='catalog-service'?plan.catalogMigrations:service==='rag-sync-service'?[{scope:'data',version:'project-generations-1',name:'RAG fixture',checksum:'a'.repeat(64)}]:[{version:1,name:'Flags fixture',checksum:'b'.repeat(64)}]);
            }
            if(settings?.input?.includes('to_regclass')&&settings.input.includes('catalog_schema_migrations'))return 't';
            return args[0]==='image'?JSON.stringify([{Id:plan.postgresImage}]):settings?.input?.includes('to_regclass')?'f':JSON.stringify(plan.catalogMigrations);
        },
        withBackup:async(config,hooks)=>{
            await hooks.beforePause();await mkdir(config.destination,{mode:0o700});await mkdir(path.join(config.destination,'databases'));
            const databases=['catalog','rag'].map(name=>({name,owner:name==='catalog'?'nc_catalog':'nc_rag',encoding:'UTF8',collate:'C.UTF-8',ctype:'C.UTF-8',file:'databases/'+name+'.dump'}));
            for(const db of databases){await writeFile(path.join(config.destination,db.file),'синтетический дамп '+db.name);}
            for(const key of volumeKeys){await mkdir(path.join(config.destination,'files',key),{recursive:true});}
            const {sha256}=await writeManifest(config.destination,{createdAt:new Date().toISOString(),postgresMajor:16,postgresImage:plan.postgresImage,images:plan.sourceImages,quiesced:true,databases});
            return hooks.afterBackup({ok:true,destination:config.destination,sha256},{remainingMs:()=>60000});
        },
    };
    try{await updateProduction(options,deps);process.send({unexpected:'completed'});}
    catch(error){process.send({unexpected:error.message});process.exitCode=1;}
});
