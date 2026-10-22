import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

export const buildPackages=[['frontend','frontend','index.html'],['catalog-service','services/catalog-service','main.js'],
    ['api-gateway','services/api-gateway','main.js'],['feature-flags-service','services/feature-flags-service','main.js'],
    ['oauth2-bridge','services/oauth2-bridge','main.js'],['rag-sync-service','services/rag-sync-service','main.js'],
    ['skills-service','services/skills-service','main.js'],['bridge','mcp/neurocenter-asset-sync','index.js']];
export const bounds={files:20000,fileBytes:64*1024**2,totalBytes:512*1024**2};
export const digest=value=>createHash('sha256').update(value).digest('hex');
export class BuildError extends Error{constructor(code,message){super(message);this.code=code;}}
const identity=info=>({dev:info.dev,ino:info.ino});
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const changed=()=>new BuildError('SOURCE_CHANGED','Source changed during observation; retry after edits settle.');

function git(root,args){
    return execFileSync('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{cwd:root,encoding:'utf8',timeout:5000,maxBuffer:8*1024**2,
        env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_OPTIONAL_LOCKS:'0'}});
}
function safePath(name){
    if(typeof name!=='string'||name.length>1024||path.posix.isAbsolute(name)||name.includes('\\')||/[\x00-\x1f\x7f]/.test(name)
        ||name.split('/').some(part=>!part||part==='.'||part==='..'||Buffer.byteLength(part)>255))throw new BuildError('UNSAFE_SOURCE','Only bounded regular repository paths are supported.');
}
/** Exclusions are explicit input scope, not a secret scanner or a security sandbox. */
export function exclusion(name){
    safePath(name);const parts=name.split('/'),base=parts.at(-1);
    if(parts.some(part=>['.git','.run','node_modules','.cache','dist','build'].includes(part))
        ||parts.includes('coverage')&&!name.startsWith('scripts/coverage/')||/^(?:bridge-dist|offline-assets|data|output|\.idea|\.playwright[^/]*)\//.test(name)
        ||/^(?:playwright-report|test-results)\//.test(name)||/\.(?:tsbuildinfo|log)$/.test(base)
        ||name==='services/api-gateway/src/docs/openapi.json'||parts.some(part=>/^\.(?:bridge-build-|.*-dist$)/.test(part)))return 'generated-or-local-output';
    if(/^\.env(?:\.|$)/.test(base)&&!base.endsWith('.example')||parts.some(part=>/^(?:secrets?|credentials?)(?:\.(?:json|ya?ml|toml|ini|env|txt))?$/i.test(part))
        ||/\.(?:pem|key|p12|pfx)$/i.test(base)||/^(?:id_rsa|id_ed25519|\.npmrc|\.gitconfig)$/i.test(base)
        ||/storageState.*\.json$|cookies.*\.txt$/i.test(base))return 'sensitive-or-active-configuration';
    return null;
}

/** Read a stable, non-linked regular file without following redirected ancestors. */
export async function regularBytes(root,name,limit=bounds.fileBytes){
    safePath(name);const file=path.join(root,name);
    if(await fs.realpath(path.dirname(file))!==path.dirname(file))throw new BuildError('UNSAFE_SOURCE','Source ancestor links are not supported.');
    const initial=await fs.lstat(file);
    if(!initial.isFile()||initial.isSymbolicLink()||initial.nlink!==1)throw new BuildError('UNSAFE_SOURCE','Source inputs must be single-link regular files.');
    if(initial.size>limit)throw new BuildError('INPUT_LIMIT','A retained file exceeds the size bound.');
    const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
        const before=await handle.stat();if(!same(initial,before)||!before.isFile()||before.nlink!==1)throw changed();
        if(before.size>limit)throw new BuildError('INPUT_LIMIT','A retained file exceeds the size bound.');
        const bytes=Buffer.alloc(before.size);let offset=0;
        while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)break;offset+=result.bytesRead;}
        const after=await handle.stat(),selected=await fs.lstat(file);
        if(!same(before,after)||!same(after,selected)||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs
            ||after.mode!==before.mode||after.nlink!==1||selected.nlink!==1||selected.isSymbolicLink()||offset!==bytes.length||await fs.realpath(file)!==file)throw changed();
        return {bytes,executable:!!(before.mode&0o111)};
    }finally{await handle.close();}
}

/** Capture current retained bytes, including dirty/new inputs and explicit tracked deletions. */
export async function sourceSnapshot(root,{destination,onCopied,signal}={}){
    if(await fs.realpath(root)!==root)throw new BuildError('UNSAFE_SOURCE','Use the canonical repository directory.');
    const head=git(root,['rev-parse','HEAD']).trim(),tracked=new Set(git(root,['ls-files','--cached','-z']).split('\0').filter(Boolean));
    const untracked=git(root,['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
    const names=[...new Set([...tracked,...untracked])].sort();if(names.length>bounds.files)throw new BuildError('INPUT_LIMIT','Too many repository entries for an isolated build.');
    const records={},excluded={};let bytes=0;const portable=new Set();
    for(const name of names){
        if(signal?.aborted)throw new BuildError('CANCELLED','The isolated build was cancelled.');
        const reason=exclusion(name);if(reason){excluded[name]=reason;continue;}
        const folded=name.normalize('NFC').toLowerCase();if(portable.has(folded))throw new BuildError('UNSAFE_SOURCE','Case-folded source paths collide.');portable.add(folded);
        let entry;try{entry=await regularBytes(root,name);}catch(error){if(error.code!=='ENOENT')throw error;if(!tracked.has(name))throw changed();records[name]={state:'deleted',tracked:true};continue;}
        bytes+=entry.bytes.length;if(bytes>bounds.totalBytes)throw new BuildError('INPUT_LIMIT','Retained source exceeds the total byte bound.');
        records[name]={state:'present',tracked:tracked.has(name),sha256:digest(entry.bytes),bytes:entry.bytes.length,executable:entry.executable};
        if(destination){const file=path.join(destination,name);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,entry.bytes,{flag:'wx',mode:entry.executable?0o700:0o600});}
        if(onCopied)await onCopied(name);
    }
    return {head,records,excluded,files:Object.values(records).filter(item=>item.state==='present').length,deleted:Object.values(records).filter(item=>item.state==='deleted').length,
        newFiles:Object.values(records).filter(item=>!item.tracked).length,bytes,digest:digest(JSON.stringify(records))};
}

export const sameSource=(left,right)=>left.head===right.head&&left.digest===right.digest&&JSON.stringify(left.excluded)===JSON.stringify(right.excluded);

/** Candidate source is checked independently of generated artifacts and existing dependency links. */
export async function candidateInputs(root,snapshot){
    const changedFiles=[];
    for(const [name,entry]of Object.entries(snapshot.records)){
        if(entry.state==='deleted'){try{await fs.lstat(path.join(root,name));changedFiles.push(name);}catch(error){if(error.code!=='ENOENT')throw error;}continue;}
        try{const value=await regularBytes(root,name);if(digest(value.bytes)!==entry.sha256||value.executable!==entry.executable)changedFiles.push(name);}catch{changedFiles.push(name);}
    }
    return {ok:changedFiles.length===0,changedFiles};
}

/** Bounded hash inventory never follows artifact links, including a symlinked dist root. */
export async function artifactTree(folder){
    let initial;try{initial=await fs.lstat(folder);}catch(error){if(error.code==='ENOENT')return {exists:false,files:{},bytes:0,digest:digest('{}')};throw error;}
    if(!initial.isDirectory()||initial.isSymbolicLink()||await fs.realpath(folder)!==folder)throw new BuildError('UNSAFE_ARTIFACT','Build output must be a regular directory without ancestor links.');
    const files={};let bytes=0,count=0;
    async function visit(relative=''){
        for(const name of(await fs.readdir(path.join(folder,relative))).sort()){
            safePath(name);const item=relative?relative+'/'+name:name;safePath(item);
            if(++count>bounds.files)throw new BuildError('OUTPUT_LIMIT','Too many build artifact entries.');
            const info=await fs.lstat(path.join(folder,item));
            if(info.isDirectory()&&!info.isSymbolicLink())await visit(item);else{
                const value=await regularBytes(folder,item);bytes+=value.bytes.length;if(bytes>bounds.totalBytes)throw new BuildError('OUTPUT_LIMIT','Build artifacts exceed the byte bound.');files[item]=digest(value.bytes);
            }
        }
    }
    await visit();const after=await fs.lstat(folder);if(!same(initial,after))throw new BuildError('ARTIFACT_CHANGED','Output directory changed during observation.');
    return {exists:true,files,bytes,digest:digest(JSON.stringify(files))};
}

/** Freeze link and target directory identities; dependency contents remain shared and are not immutable. */
export async function linkDependencies(root,repository,selection){
    const folders=['node_modules',...selection.map(([,folder])=>folder+'/node_modules')],links=[];
    for(const name of folders){
        const original=path.join(root,name),originalInfo=await fs.lstat(original),target=await fs.realpath(original),targetInfo=await fs.stat(target);
        if(!targetInfo.isDirectory())throw new BuildError('DEPENDENCIES_MISSING','Install the selected package dependencies before an isolated build.');
        const file=path.join(repository,name);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.symlink(target,file,'dir');
        links.push({path:name,target,original:identity(originalInfo),targetIdentity:identity(targetInfo),link:identity(await fs.lstat(file))});
    }
    return links;
}
export async function dependencyLinksCurrent(root,repository,links){
    for(const link of links)try{
        const original=path.join(root,link.path),file=path.join(repository,link.path),selected=await fs.lstat(file);
        if(!selected.isSymbolicLink()||!same(selected,link.link)||await fs.readlink(file)!==link.target||await fs.realpath(original)!==link.target
            ||!same(await fs.lstat(original),link.original)||!same(await fs.stat(link.target),link.targetIdentity))return false;
    }catch{return false;}return true;
}
