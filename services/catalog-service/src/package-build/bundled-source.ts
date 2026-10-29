import fs from 'node:fs/promises';
import path from 'node:path';
import {BadRequestException,ConflictException} from '@nestjs/common';
import {bundledBuildRecipe,checkedFile,type BundledBuildSource,type BundledRecipe} from '../../../shared/bundled-catalog.cjs';
import {TARGETS} from '../../../shared/runtime-artifacts.cjs';
import {RAG_PLUGIN_SOURCE} from '../../../shared/opencode-rag-source.cjs';

/** A current source recipe is pinned before enqueue and checked again before starting a producer. */
export async function resolveBundledBuild(source:BundledBuildSource,kind:string,requested?:string[]){
    let resolved:Awaited<ReturnType<typeof bundledBuildRecipe>>;
    try{resolved=await bundledBuildRecipe(source);}catch(error){throw new ConflictException(error instanceof Error?error.message:'Исходники каталога недоступны.');}
    if(resolved.plan.kind!==kind)throw new BadRequestException('Рецепт каталога относится к другому типу инструмента.');
    const supported=source.id==='mcp-opencode-rag'||source.id==='plugin-opencode-rag-plugin'?[...RAG_PLUGIN_SOURCE.supportedTargets]:[...TARGETS];
    const targets=requested??supported;
    if(targets.some(target=>!supported.includes(target)))throw new BadRequestException('Рецепт не поддерживает одну из выбранных платформ.');
    return {...resolved,targets};
}

/** Stage only files declared by the app manifest; a caller cannot select a filesystem path. */
export async function stageBundledBuild(source:BundledBuildSource,kind:string,targets:string[],stage:string){
    const resolved=await resolveBundledBuild(source,kind,targets),recipe:BundledRecipe={...resolved.recipe,targets};
    recipe.producer={schemaVersion:1,id:source.id,revision:source.revision,producerSha256:resolved.bundle.producerSha256};
    if(recipe.source.type==='project'){
        const prefix=path.posix.dirname(resolved.plan.delivery.recipe!.slice('catalog-source/'.length))+'/source/';
        for(const file of resolved.bundle.manifest.files as Array<{path:string}>){
            if(!file.path.startsWith(prefix))continue;
            const filename=path.join(stage,'source',file.path.slice(prefix.length));
            await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,await resolved.bundle.read(file.path),{flag:'wx',mode:0o600});
        }
        recipe.source={...recipe.source,directory:'source'};
    }
    return recipe;
}

/** A successful child must attest the same app producer admitted by the durable source request. */
export async function assertBundledPublication(source:{type:string},prepared:{asset:{source:{type:string;sha256?:string;bytes?:number}};sourceSnapshotPath?:string}){
    if(source.type!=='bundled')return;
    const snapshot=prepared.asset.source,filename=prepared.sourceSnapshotPath;
    if(snapshot.type!=='archive'||!snapshot.sha256||!filename||!Number.isSafeInteger(snapshot.bytes)||snapshot.bytes!>5*1024*1024)throw new ConflictException('Нет закреплённого снимка исходников поставки.');
    let actual:unknown;
    try{actual=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await checkedFile(path.dirname(filename),path.basename(filename),snapshot.sha256,snapshot.bytes!))).producer;}
    catch{throw new ConflictException('Снимок исходников поставки изменился после проверки.');}
    const resolved=await bundledBuildRecipe(source);
    const expected={schemaVersion:1,id:(source as BundledBuildSource).id,revision:(source as BundledBuildSource).revision,producerSha256:resolved.bundle.producerSha256};
    if(!actual||typeof actual!=='object'||Array.isArray(actual)||Object.keys(actual).sort().join(',')!==Object.keys(expected).sort().join(',')
        ||Object.entries(expected).some(([key,value])=>(actual as Record<string,unknown>)[key]!==value))throw new ConflictException('Сборщик не подтвердил точные исходники поставки каталога.');
}
