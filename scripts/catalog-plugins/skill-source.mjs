import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {downloadRepositoryArchive,repositoryRoot} from './repository-source.mjs';
import {extractRelease} from './source-adapters.mjs';
import repository from '../../services/shared/repository-source.cjs';

/** Read a pinned skill tree without installing dependencies or executing any repository code. */
export async function readSkillRepository(raw,stage,{downloadArchive}={}){
    const source=repository.validateRepositorySource(raw);
    if(!/(?:^|\/)SKILL\.md$/.test(source.entrypoint)||source.release||source.runtimeSource)throw new Error('Для скилла выберите исходники с SKILL.md, без runtime или релиза.');
    const cache=path.join(stage,'repository-cache');
    const archive=downloadArchive?await downloadArchive(source):await downloadRepositoryArchive(source,cache);
    const root=await repositoryRoot(archive.archivePath,source),extracted=path.join(stage,'repository');
    await fs.mkdir(extracted,{mode:0o700});
    await extractRelease(archive.archivePath,{format:'tar.gz'},extracted);
    let directory=path.join(extracted,root);
    const entryDirectory=path.posix.dirname(source.entrypoint),selectedPrefix=entryDirectory==='.'?'':entryDirectory+'/';
    for(const part of [source.subdirectory??'',entryDirectory==='.'?'':entryDirectory].join('/').split('/').filter(Boolean)){
        directory=path.join(directory,part);const info=await fs.lstat(directory);
        if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Подпапка скилла отсутствует или является ссылкой.');
    }
    const files=[];let bytes=0;
    const walk=async(prefix='')=>{
        for(const name of (await fs.readdir(path.join(directory,prefix))).sort()){
            const relative=prefix?prefix+'/'+name:name,filename=path.join(directory,relative),info=await fs.lstat(filename);
            if(info.isDirectory()){await walk(relative);continue;}
            if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>1024**2||files.length>=100)throw new Error('Скилл: обычные текстовые файлы, до 100 файлов и 1 МиБ на файл.');
            const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
            try{
                const before=await handle.stat();if(!before.isFile()||before.nlink!==1||before.ino!==info.ino||before.size>1024**2)throw new Error('Ресурс скилла изменился при чтении.');
                const contents=await handle.readFile(),after=await handle.stat();bytes+=contents.length;
                if(contents.length!==before.size||before.mtimeMs!==after.mtimeMs||bytes>5*1024**2)throw new Error('Скилл изменился или превышает 5 МиБ.');
                let content,encoding;
                try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(contents);if(content.includes('\0'))throw new Error();}
                catch{if(!/^(?:scripts|references|assets)\//.test(relative))throw new Error('Инструкция скилла должна быть текстом UTF-8.');content=contents.toString('base64');encoding='base64';}
                files.push({path:selectedPrefix+relative,content,...(encoding?{encoding}:{})});
            }finally{await handle.close();}
        }
    };
    await walk();return files;
}
