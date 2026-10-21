import path from 'node:path';
import {readBoundedSnapshot} from '../../bridge/read-bounded.js';
import {readOpenCodeModelMetadata} from '../../bridge/opencode-model-scan.js';
import type {ProjectAgentsPayload} from './contract.js';
import fs from 'node:fs/promises';
import {parse,type ParseError} from 'jsonc-parser';
import {CONFIG_PATHS} from '../../bridge/installation-files.js';
import {safeTarget} from '../../bridge/workspace.js';
import {extractFrontmatter} from '../../lib/frontmatter.js';
import type {InstallationPlan} from '../../bridge/installation-plan.js';

export const agentConflict=(message:string):Error=>Object.assign(new Error(message),{code:'AGENTS_LOCAL_CONFLICT'});

/** Alternate JSON, legacy directories and case aliases must not silently shadow a managed native agent. */
export async function assertAgentNamespace(plan:InstallationPlan,slugs:string[],ownedSlugs:string[],source:ProjectAgentsPayload):Promise<void>{
    const names=new Set(slugs);
    const owned=new Set(ownedSlugs);
    for(const file of CONFIG_PATHS){
        const text=await plan.read(file);if(text===null)continue;
        const errors:ParseError[]=[];const config=parse(text,errors,{allowTrailingComma:true}) as Record<string,unknown>|null;
        if(errors.length||!config||typeof config!=='object'||Array.isArray(config))throw agentConflict('Исправьте JSON/JSONC OpenCode перед настройкой агентов.');
        for(const key of ['agent','mode'])if(config[key]!==undefined){
            if(!config[key]||typeof config[key]!=='object'||Array.isArray(config[key]))throw agentConflict('Поле '+key+' в OpenCode должно быть объектом.');
            if(Object.keys(config[key]).some(name=>/^nc-/.test(name.toLowerCase())||names.has(name.toLowerCase())))throw agentConflict('Имя агента уже настроено вручную в OpenCode. Локальная конфигурация сохранена.');
        }
    }
    let scanned=0,bytes=0;
    const scan=async(directory:string,recursive:boolean,depth=0):Promise<void>=>{
        if(depth>16)throw agentConflict('Вложенность папок агентов превышает предел проверки.');
        const target=await safeTarget(plan.root,directory);
        const entries=await fs.readdir(target,{withFileTypes:true}).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return[];throw error;});
        for(const entry of entries){
            if(++scanned>2048)throw agentConflict('Слишком много локальных файлов агентов для безопасной проверки.');
            if(entry.isSymbolicLink())throw agentConflict('Папки агентов содержат симлинк. Локальные файлы сохранены.');
            const relative=directory+'/'+entry.name;
            if(entry.isDirectory()){if(recursive)await scan(relative,true,depth+1);continue;}
            const name=entry.name.toLowerCase();
            if(/^nc-.*\.md$/.test(name)&&!owned.has(name.slice(0,-3)))throw agentConflict('В папке OpenCode найден агент с именем Нейроцентра без подтверждённого владения. Локальные файлы сохранены.');
            if(!name.endsWith('.md'))continue;
            if(names.has(name.slice(0,-3))&&(directory!=='.opencode/agents'||entry.name!==name))throw agentConflict('Имя агента занято другим локальным файлом OpenCode. Локальные файлы сохранены.');
            const text=await plan.read(relative);if(text===null){
                if(directory==='.opencode/agents'&&owned.has(name.slice(0,-3)))continue; // The snapshot may already plan its owned removal.
                throw agentConflict('Файл агента изменился во время проверки.');
            }
            bytes+=Buffer.byteLength(text);if(bytes>8*1024*1024)throw agentConflict('Локальные файлы агентов превышают предел проверки.');
            const header=extractFrontmatter(text),alias=header?.name;
            if(typeof alias==='string'&&(/^nc-/.test(alias.toLowerCase())||names.has(alias.toLowerCase())))throw agentConflict('Имя агента занято в заголовке другого локального файла OpenCode. Локальные файлы сохранены.');
        }
    };
    const namespace={names:new Set<string>(),directories:new Set<string>()};
    const metadata=await readOpenCodeModelMetadata(plan.root,{scope:'project',projectId:source.projectId,bindingId:source.bindingId,instanceId:source.instanceId},
        {readAuth:false,agentNamespaceTarget:namespace});
    if(metadata.warnings.some(warning=>['invalid-json','unsafe-path','read-failed','source-changed'].includes(warning)))throw agentConflict('Исправьте JSON/JSONC или небезопасные пути OpenCode перед настройкой агентов.');
    if([...namespace.names].some(name=>/^nc-/.test(name.toLowerCase())||names.has(name.toLowerCase())))throw agentConflict('Имя агента уже настроено в общей или проектной конфигурации OpenCode.');
    const external=async(directory:string,depth=0):Promise<void>=>{
        if(depth>16)throw agentConflict('Вложенность общих агентов превышает предел проверки.');
        let entries;try{
            let current=path.parse(directory).root;for(const part of directory.slice(current.length).split(path.sep)){current=path.join(current,part);if((await fs.lstat(current)).isSymbolicLink())throw agentConflict('Общие агенты содержат симлинк.');}
            entries=await fs.readdir(directory,{withFileTypes:true});
        }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
        for(const entry of entries){
            if(++scanned>2048)throw agentConflict('Слишком много общих и проектных файлов агентов для проверки.');
            if(entry.isSymbolicLink())throw agentConflict('Общие агенты содержат симлинк.');
            const absolute=path.join(directory,entry.name);if(entry.isDirectory()){await external(absolute,depth+1);continue;}
            const name=entry.name.toLowerCase();if(!name.endsWith('.md'))continue;
            if(/^nc-/.test(name)||names.has(name.slice(0,-3)))throw agentConflict('Имя агента занято общим файлом OpenCode. Прежние файлы сохранены.');
            const snapshot=await readBoundedSnapshot(absolute,1024*1024),text=snapshot.bytes.toString('utf8');bytes+=snapshot.bytes.length;
            if(bytes>8*1024*1024||!Buffer.from(text).equals(snapshot.bytes))throw agentConflict('Общие агенты превышают предел проверки или содержат некорректный текст.');
            const alias=extractFrontmatter(text)?.name;if(typeof alias==='string'&&(/^nc-/.test(alias.toLowerCase())||names.has(alias.toLowerCase())))throw agentConflict('Имя агента занято в заголовке общего файла OpenCode.');
        }
    };
    for(const directory of namespace.directories){
        if(path.resolve(directory)===path.resolve(plan.root,'.opencode'))continue;
        for(const kind of ['agents','agent','mode','modes'])await external(path.join(directory,kind));
    }
    for(const directory of ['.opencode/agents','.opencode/agent','.opencode/mode','.opencode/modes'])await scan(directory,directory.endsWith('/agents')||directory.endsWith('/agent'));
}
