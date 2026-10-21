import {ConflictException,PayloadTooLargeException} from '@nestjs/common';
import {assetDigest,serializeAsset,validateAsset,type ToolAsset,type SkillAsset} from '@neurocenter/asset-contract';
import {constants,createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import * as tar from 'tar';
import type {ISourceReceipt} from '../asset-sources/import-types';
import type {AssetBlobStore} from '../asset-sources/asset-blob-store';
import {runtimeArtifactDirectory} from '../runtime-artifacts/runtime-artifacts';
import {reserveCapacity} from '../../../shared/capacity.cjs';
import {cleanStaleSupplyStages,markSupplyStage} from './supply-staging';

export const maximumSupplyBytes=4*1024**3;
interface SupplyFile {sha256:string;bytes:number;name:string;roles:string[]}
export interface ToolSupplyPlan {asset:ToolAsset|SkillAsset;descriptor:Buffer;files:SupplyFile[];filename:string;inputBytes:number}
const missing=()=>new ConflictException('Точная поставка этой сборки недоступна. Восстановите исходные проверенные файлы ассета.');

/** Transport is a tar container around the existing envelope, never another asset schema. */
export function toolSupplyPlan(receipt:ISourceReceipt):ToolSupplyPlan{
    let asset:ToolAsset|SkillAsset,descriptor:Buffer;
    try{const checked=validateAsset(receipt.descriptor);if(!['mcp','plugin','skill'].includes(checked.kind))throw missing();asset=checked as ToolAsset|SkillAsset;descriptor=Buffer.from(serializeAsset(asset));}catch{throw missing();}
    if(receipt.repository!=='local-archive'||receipt.asset_kind!==asset.kind||receipt.external_id!==asset.id||receipt.asset_version!==asset.version
        ||assetDigest(descriptor)!==receipt.descriptor_sha256||!Array.isArray(receipt.blobs))throw missing();
    const retained=new Map<string,number>();
    for(const blob of receipt.blobs){if(!blob||!/^[a-f0-9]{64}$/.test(blob.sha256)||!Number.isSafeInteger(blob.bytes)||blob.bytes<1||retained.has(blob.sha256)&&retained.get(blob.sha256)!==blob.bytes)throw missing();retained.set(blob.sha256,blob.bytes);}
    const unique=new Map<string,SupplyFile>(),names=new Set(['asset.json','readme.md']);
    const add=(sha256:string,bytes:number,name:string,role:string,exactPath=false)=>{
        if(retained.get(sha256)!==bytes)throw missing();
        const previous=unique.get(sha256);if(previous){if(previous.bytes!==bytes)throw missing();if(!exactPath||previous.name===name){previous.roles.push(role);return;}}
        const lower=name.toLowerCase();if([...names].some(saved=>saved===lower||saved.startsWith(lower+'/')||lower.startsWith(saved+'/')))throw missing();names.add(lower);unique.set(previous?sha256+':recipe':sha256,{sha256,bytes,name,roles:[role]});
    };
    if(asset.kind!=='skill')for(const {descriptor:item} of asset.delivery.artifacts)add(item.sha256,item.compressedBytes,'artifacts/'+item.sha256+'.tar.gz','runtime '+item.target);
    if(asset.source.type==='archive')add(asset.source.sha256,asset.source.bytes,'source/'+asset.source.sha256+'.source','original source snapshot (opaque bytes)');
    if(asset.recipe){const bytes=retained.get(asset.recipe.sha256);if(!bytes||bytes>1024**2)throw missing();add(asset.recipe.sha256,bytes,asset.recipe.path,'public recipe',true);}
    const files=[...unique.values()],inputBytes=files.reduce((sum,file)=>sum+file.bytes,descriptor.length);
    if(!Number.isSafeInteger(inputBytes)||inputBytes>maximumSupplyBytes-64*1024**2)throw new PayloadTooLargeException('Поставка превышает предел выгрузки 4 ГиБ.');
    return {asset,descriptor,files,inputBytes,filename:asset.id+'-'+asset.version+'-supply.tar.gz'};
}

function readme(plan:ToolSupplyPlan):string{
    return `# Поставка ${plan.asset.id} ${plan.asset.version}\n\nasset.json — исходный дескриптор без изменения байтов и public URL. SHA-256: ${assetDigest(plan.descriptor)}.\n\n`
        +'Файлы поставки (SHA-256, число байтов, путь):\n\n'+plan.files.map(file=>`${file.sha256}  ${file.bytes}  ${file.name} (${file.roles.join(', ')})`).join('\n')+'\n\n'
        +'Source snapshot — точные исходные байты, расширение .source не задаёт формат: это может быть бинарный файл, ZIP, TAR.GZ или JSON. Не преобразуйте и не перекодируйте его.\n\n'
        +'Для переноса на другой сервер разместите файлы в его проверяемом SHA-хранилище и импортируйте этот asset.json штатным импортом ассетов.\n\n'
        +'Для публичной публикации загрузите файлы в immutable GitHub Release. Только перед первой публикацией версии можно добавить реальные URL доставки в копию asset.json; затем пересчитайте SHA дескриптора в index.json. Уже опубликованные версии не переписывайте: изменение опубликованного дескриптора требует новой версии. SHA и размеры исходников/runtime менять нельзя.\n';
}

/** Copies verified handles with backpressure; cancellation never changes retained source bytes. */
export async function createToolSupply(plan:ToolSupplyPlan,blobs:Pick<AssetBlobStore,'open'>,signal:AbortSignal){
    signal.throwIfAborted();
    const artifactRoot=runtimeArtifactDirectory();await fs.mkdir(artifactRoot,{recursive:true,mode:0o700});
    const artifactInfo=await fs.lstat(artifactRoot);if(!artifactInfo.isDirectory()||artifactInfo.isSymbolicLink())throw missing();
    const root=path.join(artifactRoot,'.supply-export');await fs.mkdir(root,{recursive:true,mode:0o700});
    const info=await fs.lstat(root);if(!info.isDirectory()||info.isSymbolicLink())throw missing();
    await cleanStaleSupplyStages(root);signal.throwIfAborted();
    let stage:string|undefined,download:ReturnType<fs.FileHandle['createReadStream']>|undefined,release:()=>void=()=>undefined;
    const cleanup=async()=>{try{if(download&&!download.closed)await new Promise<void>(resolve=>{download!.once('close',resolve);download!.destroy();});if(stage)await fs.rm(stage,{recursive:true,force:true});}finally{release();}};
    try{
        release=await reserveCapacity({resource:'runtime-artifacts',bytes:plan.inputBytes*2+64*1024**2,path:root});signal.throwIfAborted();
        stage=await fs.mkdtemp(path.join(root,'export-'));
        await markSupplyStage(stage);
        const contents=path.join(stage,'files');await fs.mkdir(contents,{mode:0o700});
        await fs.writeFile(path.join(contents,'asset.json'),plan.descriptor,{flag:'wx',mode:0o600});
        await fs.writeFile(path.join(contents,'README.md'),readme(plan),{flag:'wx',mode:0o600});
        for(const file of plan.files){
            signal.throwIfAborted();const source=await blobs.open(file.sha256,signal);
            if(source.bytes!==file.bytes){source.stream.destroy();throw missing();}
            const target=path.join(contents,file.name);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
            let bytes=0;const hash=createHash('sha256');
            await pipeline(source.stream,new Transform({transform(chunk:Buffer,_encoding,done){bytes+=chunk.length;hash.update(chunk);done(bytes>file.bytes?missing():null,chunk);}}),createWriteStream(target,{flags:'wx',mode:0o600}),{signal});
            if(bytes!==file.bytes||hash.digest('hex')!==file.sha256)throw missing();
        }
        signal.throwIfAborted();const archive=path.join(stage,'supply.tar.gz');let bytes=0;
        await pipeline(tar.create({cwd:contents,portable:true,noMtime:true,strict:true,gzip:true},['asset.json','README.md',...plan.files.map(file=>file.name)]),
            new Transform({transform(chunk:Buffer,_encoding,done){bytes+=chunk.length;done(bytes>maximumSupplyBytes?new PayloadTooLargeException('Поставка превышает предел выгрузки 4 ГиБ.'):null,chunk);}}),createWriteStream(archive,{flags:'wx',mode:0o600}),{signal});
        const handle=await fs.open(archive,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),saved=await handle.stat();
        if(!saved.isFile()||saved.nlink!==1||saved.size!==bytes){await handle.close();throw missing();}
        download=handle.createReadStream({autoClose:true});return {filename:plan.filename,bytes,stream:download,cleanup};
    }catch(error){await cleanup();throw error;}
}
