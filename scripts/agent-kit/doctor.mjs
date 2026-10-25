import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateKit,repositoryRoot} from './generate.mjs';
import {installCodexKit} from './install-codex.mjs';

const usage='Usage: node scripts/agent-kit/doctor.mjs [--observed-tool <name>]...\nRead-only checks of generated kit files, installed files and a caller-supplied MCP tool catalogue.\nOmit --observed-tool to leave client discovery unverified. This command never queries the active client.\n';
const toolPattern=/^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

/** Accept only bounded public tool names; never interpret input as a path or command. */
function toolNames(value,label){
    if(!Array.isArray(value)||value.length>128||value.some(name=>typeof name!=='string'||!toolPattern.test(name))||new Set(value).size!==value.length)
        throw new TypeError(`${label} must contain at most 128 unique public tool names of 1-128 characters.`);
    return [...value].sort();
}

function rootPath(value){
    if(typeof value!=='string'||!value||value.length>4096||value.includes('\0'))throw new TypeError('Kit and Codex home paths must be nonempty bounded strings.');
    return path.resolve(value);
}

/** Keep filesystem errors and malformed source contents out of the public report. */
function failure(error,scope){
    const message=typeof error?.message==='string'?error.message:'';
    if(scope==='repository'&&message.startsWith('Сохранён изменённый устаревший файл'))return {status:'mismatch',code:'GENERATED_OBSOLETE_MODIFIED',message:'An obsolete generated file was modified; its contents were preserved. Resolve its ownership conflict before regenerating.'};
    if(scope==='repository'&&message.startsWith('Сохранён изменённый файл'))return {status:'mismatch',code:'GENERATED_FILE_MODIFIED',message:'A generated file differs from its recorded ownership; preserve the changes and resolve the source conflict.'};
    if(scope==='installedCopy'&&message.startsWith('Modified obsolete user file preserved:'))return {status:'mismatch',code:'INSTALLED_OBSOLETE_MODIFIED',message:'An obsolete installed file was modified; its contents were preserved. Resolve its ownership conflict before updating.'};
    if(scope==='installedCopy'&&message.startsWith('Existing user file preserved:'))return {status:'mismatch',code:'INSTALLED_FILE_MODIFIED',message:'An installed file was modified outside the kit; its contents were preserved.'};
    if(scope==='installedCopy'&&message.startsWith('The installed kit is missing,'))return {status:'mismatch',code:'INSTALLED_COPY_DIFFERS',message:'Installed files or the ownership receipt are missing, differ from the source, or require retirement/legacy migration. Inspect the installer plan.'};
    if(message.startsWith('Kit integrity mismatch:'))return {status:'mismatch',code:'SOURCE_INTEGRITY_MISMATCH',message:'A source file differs from the kit manifest; regenerate or resolve the source changes before checking the installation.'};
    if(message.startsWith('Modified legacy user file preserved:'))return {status:'mismatch',code:'LEGACY_FILE_MODIFIED',message:'A legacy installed file was modified outside the kit; its contents were preserved.'};
    if(error?.code==='ENOENT'||message.startsWith('Missing kit file:')||message.startsWith('Нет общего файла '))return {status:'mismatch',code:'KIT_FILE_MISSING',message:'A required kit file is missing; restore the source files and retry.'};
    return {status:'error',code:'CHECK_UNAVAILABLE',message:scope==='repository'?'Generated files and manifest could not be checked safely; inspect the kit source and retry.':'The installed kit could not be checked safely; inspect the kit files and ownership receipt and retry.'};
}

/** Observe source, installed files and supplied discovery evidence without changing any files. */
export async function doctorKit({kitRoot=repositoryRoot,codexHome=process.env.CODEX_HOME||path.join(homedir(),'.codex'),observedTools,expectedTools}={}){
    kitRoot=rootPath(kitRoot);codexHome=rootPath(codexHome);
    const observed=observedTools===undefined?undefined:toolNames(observedTools,'observedTools');
    const catalog=expectedTools===undefined?await import('../dev-mcp/tool-catalog.mjs'):null;
    const expected=toolNames(expectedTools??catalog.toolDefinitions(catalog.toolFlags()).map(tool=>tool.name),'expectedTools');
    let repository,installedCopy;
    try{
        const result=await generateKit({root:kitRoot,checkOnly:true});
        repository={status:result.changed.length||result.obsolete.length?'mismatch':'pass',check:'generated-files-and-manifest',version:result.version,roles:result.roles,skills:result.skills,checkedFiles:result.checkedFiles,changed:result.changed,obsolete:result.obsolete};
    }catch(error){repository={...failure(error,'repository'),check:'generated-files-and-manifest'};}
    try{
        const result=installCodexKit({kitRoot,codexHome,check:true});
        installedCopy={status:'pass',check:'files-and-ownership-receipt',roles:result.roleCount,skills:result.skillCount,checkedFiles:result.fileCount};
    }catch(error){installedCopy={...failure(error,'installedCopy'),check:'files-and-ownership-receipt'};}
    const missing=observed===undefined?[]:expected.filter(name=>!observed.includes(name));
    const unexpected=observed===undefined?[]:observed.filter(name=>!expected.includes(name));
    const observedClient=observed===undefined
        ?{status:'unknown',evidence:'not-supplied',message:'Client discovery was not observed. File checks do not verify loaded roles, skills or tools.',expectedTools:expected}
        :{status:missing.length||unexpected.length?'mismatch':'pass',evidence:'caller-supplied',message:'Compared supplied public tool names only; no active-client discovery or tool execution was performed.',expectedTools:expected,observedTools:observed,missing,unexpected};
    const statuses=[repository.status,installedCopy.status,observedClient.status];
    return {schemaVersion:1,status:statuses.includes('error')?'error':statuses.includes('mismatch')?'mismatch':statuses.includes('unknown')?'unverified':'pass',repository,installedCopy,observedClient};
}

function argumentsFor(args){
    if(args.length===1&&args[0]==='--help')return {help:true};
    if(args.length>256||args.length%2||args.some((arg,index)=>index%2===0&&arg!=='--observed-tool'))throw new TypeError(usage.trim());
    const values=args.filter((_,index)=>index%2===1);
    return {observedTools:args.length?toolNames(values,'--observed-tool'):undefined};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    try{
        const args=argumentsFor(process.argv.slice(2));
        if(args.help)process.stdout.write(usage);
        else{
            const result=await doctorKit(args);
            process.stdout.write(JSON.stringify(result,null,2)+'\n');
            if(['mismatch','error'].includes(result.status))process.exitCode=1;
        }
    }catch{process.stderr.write('Invalid doctor arguments or unavailable tool catalogue. '+usage);process.exitCode=1;}
}
