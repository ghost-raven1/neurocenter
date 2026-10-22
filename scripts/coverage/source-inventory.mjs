import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat,open,readFile,mkdir,writeFile,realpath} from 'node:fs/promises';

export const coveragePackages=[['frontend','frontend'],['catalog-service','services/catalog-service'],['api-gateway','services/api-gateway'],['feature-flags-service','services/feature-flags-service'],['oauth2-bridge','services/oauth2-bridge'],['rag-sync-service','services/rag-sync-service'],['skills-service','services/skills-service'],['bridge','mcp/neurocenter-asset-sync']];
const javascript=/\.[cm]?[jt]sx?$/i,declaration=/\.d\.[cm]?ts$/i;
const otherLanguages={'.sh':'shell','.bash':'shell','.zsh':'shell','.ps1':'powershell','.py':'python','.sql':'sql','.rb':'ruby','.pl':'perl','.php':'php','.go':'go','.rs':'rust','.java':'java','.kt':'kotlin','.swift':'swift','.c':'c','.cc':'cpp','.cpp':'cpp','.cs':'csharp'};
const slash=value=>value.split(path.sep).join('/');
const digest=value=>createHash('sha256').update(value).digest('hex');

function ownership(file){
    if(declaration.test(file))return{role:'declaration',kind:'types',reason:'Type declarations do not execute.'};
    if(/(?:^|\/)(?:test|tests|__tests__|fixtures)(?:\/|$)/.test(file)||/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))return{role:'verification',kind:'test-or-fixture',reason:'Explicit test/fixture path or test filename.'};
    if(file.startsWith('bridge-dist/'))return{role:'production',kind:'installer',generated:true,reason:'Versioned shipped installers remain production even when generated.'};
    if(file.endsWith('.sql'))return{role:'production',kind:'sql-source',reason:'SQL script/migration is unmeasured; executing a TypeScript SQL string does not verify SQL semantics.'};
    if(coveragePackages.some(([,folder])=>file.startsWith(folder+'/native/')))return{role:'production',kind:'native-helper',reason:'Native helper shipped with a configured package; requires separate runtime measurement.'};
    if(file==='mcp/neurocenter-asset-sync/scripts/probe-store.mjs')return{role:'production',kind:'operator-cli',reason:'Operator CLI inspecting the local LanceDB store.'};
    if(file==='mcp/neurocenter-asset-sync/scripts/build.mjs')return{role:'tooling',kind:'package-build',reason:'Package compiler and distribution staging, outside production runtime.'};
    if(file==='mcp/neurocenter-asset-sync/scripts/test-local-configuration-smoke.mjs')return{role:'verification',kind:'build-smoke',reason:'Local-configuration smoke verification on disposable data.'};
    if(coveragePackages.some(([,folder])=>file.startsWith(folder+'/src/')))return{role:'production',kind:'application',reason:'Configured package production source tree.'};
    if(file.startsWith('services/shared/')&&!file.includes('test-coverage.'))return{role:'production',kind:'shared',reason:'Shared production contracts and runtime helpers.'};
    if(/^scripts\/(?:coverage|workspace|openapi)\//.test(file)||/(?:^|\/)(?:[^/]*\.config\.[^/]+|test-coverage\.[^/]+)$/.test(file))return{role:'tooling',kind:'verification-or-configuration',reason:'Coverage, workspace verification, generated API tooling or configuration.'};
    if(file.startsWith('scripts/'))return{role:'production',kind:'operator-cli',reason:'Operational CLI and its helpers outside the configured package src trees.'};
    if(/(?:^|\/)(?:dist|build|coverage)\//.test(file))return{role:'generated',kind:'build-output',reason:'Generated output is recorded separately from original production source.'};
    return{role:'unclassified',kind:'unclassified-source',reason:'Executable source outside known roots; requires explicit ownership, never silently excluded.'};
}

/** Git defines the retained source set; ignored dependencies, local evidence and binary releases are not walked. */
export function repositorySourceFiles(root){
    return [...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,maxBuffer:32*1024**2}).toString().split('\0').filter(Boolean))].sort();
}

/** Inventory does not execute entrypoints, import production modules or invent zero line counters. */
export async function collectSourceInventory(root,files=repositorySourceFiles(root)){
    root=await realpath(root);
    const records=[];
    for(const name of [...new Set(files)].sort()){
        const absolute=path.resolve(root,name),relative=slash(path.relative(root,absolute));
        if(!relative||relative.startsWith('../')||path.isAbsolute(relative))throw Error('Source inventory path must stay inside its repository.');
        const known=javascript.test(relative)||Object.hasOwn(otherLanguages,path.extname(relative).toLowerCase());
        if(/(?:^|\/)(?:\.env(?:\..*)?|secrets?|credentials?)(?:\/|$)|\.(?:pem|key|p12|pfx)$/.test(relative)){
            if(known)records.push({path:relative,role:'unclassified',kind:'sensitive-path',reason:'Sensitive paths are not opened or hashed.',language:'unknown',instrumentable:false,sha256:null,unavailable:'Sensitive source deliberately unread.'});continue;
        }
        let info;try{info=await lstat(absolute);}catch(error){if(error.code!=='ENOENT')throw error;if(known)records.push({path:relative,...ownership(relative),language:'unknown',instrumentable:false,sha256:null,unavailable:'Missing retained source file.'});continue;}
        if(info.isSymbolicLink()){records.push({path:relative,role:'unclassified',kind:'symlink',reason:'Symlink source is not followed outside the retained tree.',language:'unknown',instrumentable:false,sha256:null,unavailable:'Symlink not followed.'});continue;}
        if(!info.isFile())continue;
        const canonical=await realpath(absolute);
        if(canonical!==absolute){records.push({path:relative,role:'unclassified',kind:'ancestor-symlink',reason:'A parent directory redirects this retained source path.',language:'unknown',instrumentable:false,sha256:null,unavailable:'Ancestor symlink not followed.'});continue;}
        let prefix='';
        if(!known){
            if(!/^(?:scripts|bridge-dist|bin)\//.test(relative)&&!(info.mode&0o111))continue;
            const file=await open(absolute,'r');try{const buffer=Buffer.alloc(256),{bytesRead}=await file.read(buffer,0,buffer.length,0);prefix=buffer.subarray(0,bytesRead).toString('utf8');}finally{await file.close();}if(!prefix.startsWith('#!'))continue;
        }
        const language=javascript.test(relative)?'javascript-typescript':otherLanguages[path.extname(relative).toLowerCase()]??(/\b(?:node|nodejs)\b/.test(prefix.split('\n')[0])?'javascript-typescript':'unknown-shebang');
        records.push({path:relative,...ownership(relative),language,instrumentable:language==='javascript-typescript'&&!declaration.test(relative),sha256:digest(await readFile(absolute))});
    }
    return{schemaVersion:1,discovery:'git cached + nonignored untracked; standalone source extensions and shebangs',inventoryComplete:!records.some(file=>file.unavailable),files:records};
}

/** A represented file is present in one instrumentation map; it does not imply executed lines or correctness. */
export function reconcileSourceInventory(inventory,represented,root,coverageKind){
    if(inventory?.schemaVersion!==1||!Array.isArray(inventory.files))return{schemaVersion:1,inventoryComplete:false,reason:'Retained source inventory is unavailable; rerun inventory instead of assuming a full denominator.',files:[],summary:null,allProductionSourcesRepresented:false};
    const paths=new Set(represented.map(file=>slash(path.relative(root,path.resolve(root,file)))));
    const files=inventory.files.map(file=>({...file,measurement:file.unavailable?'source-unavailable':!file.instrumentable?'unsupported-runtime':paths.has(file.path)?'represented':'unrepresented'}));
    const production=files.filter(file=>file.role==='production'),unclassified=files.filter(file=>file.role==='unclassified');
    const count=measurement=>production.filter(file=>file.measurement===measurement).length;
    return{...inventory,coverageKind,files,summary:{production:{total:production.length,represented:count('represented'),unrepresented:count('unrepresented'),unsupported:count('unsupported-runtime'),unavailable:count('source-unavailable')},unclassified:unclassified.length,verification:files.filter(file=>file.role==='verification').length,tooling:files.filter(file=>file.role==='tooling').length,generated:files.filter(file=>file.role==='generated').length,declarations:files.filter(file=>file.role==='declaration').length},
        allProductionSourcesRepresented:inventory.inventoryComplete&&production.length>0&&unclassified.length===0&&production.every(file=>file.measurement==='represented')};
}

/** Retained merges never substitute today's files for missing or differing historical inventories. */
export function mergeSourceInventories(inventories,represented,root,coverageKind){
    const valid=inventories.every(item=>item?.schemaVersion===1&&Array.isArray(item.files));
    if(!valid)return reconcileSourceInventory(null,represented,root,coverageKind);
    const signatures=new Set(inventories.filter(Boolean).map(item=>JSON.stringify(item.files.map(({measurement,...file})=>file))));
    if(signatures.size!==1)return reconcileSourceInventory(null,represented,root,coverageKind);
    return reconcileSourceInventory(inventories[0],represented,root,coverageKind);
}

export async function writeSourceInventory(inventory,folder){
    await writeFile(path.join(folder,'source-inventory.json'),JSON.stringify(inventory,null,2)+'\n');
    const production=inventory.files.filter(file=>file.role==='production'),unclassified=inventory.files.filter(file=>file.role==='unclassified');
    const lines=['# Инвентаризация исполняемых исходников','',inventory.reason??'Это файловый знаменатель, а не процент покрытия строк, функций, ветвей или statements.',
        '',`Полнота инвентаризации: ${inventory.inventoryComplete?'да':'нет'}. Все production-исходники представлены картой: ${inventory.allProductionSourcesRepresented?'да':'нет'}.`,
        '',`Production: ${production.length}. Представлены: ${inventory.summary?.production.represented??'неизвестно'}. Не представлены: ${inventory.summary?.production.unrepresented??'неизвестно'}. Неподдержанный runtime: ${inventory.summary?.production.unsupported??'неизвестно'}. Не классифицированы: ${unclassified.length}.`,
        '', '| Файл | Назначение | Runtime | Измерение | Основание |','|---|---|---|---|---|',...production.concat(unclassified).map(file=>`| ${file.path.replaceAll('|','\\|')} | ${file.kind} | ${file.language} | ${file.measurement} | ${file.reason} |`),
        '', 'Tests, tooling, generated outputs и declarations также сохранены с основаниями в source-inventory.json. Bash/PowerShell/Python не получают выдуманные нулевые или100% счётчики. Встроенный в строки/шаблоны код не является отдельным файлом этой инвентаризации.',''];
    await writeFile(path.join(folder,'source-inventory.md'),lines.join('\n'));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--output')throw Error('Usage: node scripts/coverage/source-inventory.mjs --output <new-directory>');
    const root=fileURLToPath(new URL('../../',import.meta.url)),folder=path.resolve(args[1]),inventory=reconcileSourceInventory(await collectSourceInventory(root),[],root,'unmeasured-inventory');
    await mkdir(path.dirname(folder),{recursive:true});await mkdir(folder);await writeSourceInventory(inventory,folder);console.log(path.join(folder,'source-inventory.json'));
}
