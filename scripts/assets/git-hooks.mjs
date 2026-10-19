import {spawnSync} from 'node:child_process';
import {access,chmod,lstat,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

const marker='neurocenter-assets-hooks-v1';
const hooks=['applypatch-msg','pre-applypatch','post-applypatch','pre-commit','pre-merge-commit','prepare-commit-msg',
    'commit-msg','post-commit','pre-rebase','post-checkout','post-merge','pre-push','pre-receive','update',
    'proc-receive','post-receive','post-update','reference-transaction','push-to-checkout','pre-auto-gc',
    'post-rewrite','sendemail-validate','fsmonitor-watchman','p4-changelist','p4-prepare-changelist','post-index-change'];
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";

/** Сохраняем NODE_BIN и общий runtime linked worktrees; удалённый Node заменяем доступным. */
function nodeBootstrap(root,node) {
    const relative=path.relative(root,node);
    const installed=relative&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)
        ? `"$repo"/${quote(relative)}`:quote(node);
    return `node_bin=\${NODE_BIN:-}\nif [ -z "$node_bin" ]; then
  node_bin=${installed}
  if [ ! -x "$node_bin" ] && [ -x ${quote(node)} ]; then node_bin=${quote(node)}; fi
  if [ ! -x "$node_bin" ]; then
    node_bin=
    for candidate in "$repo"/.run/toolchains/node-v24.*/bin/node; do
      if [ -x "$candidate" ] && "$candidate" -e "" >/dev/null 2>&1; then node_bin=$candidate; break; fi
    done
    if [ -z "$node_bin" ]; then node_bin=$(command -v node) || exit 1; fi
  fi
fi\n`;
}

/** Параллельные Git-команды обновляют обёртки через независимые временные файлы. */
async function replaceHookFile(file,content,mode) {
    const temporary=`${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary,content,{mode,flag:'wx'});await chmod(temporary,mode);
        await rename(temporary,file);
    } finally {await rm(temporary,{force:true});}
}

function git(root,args,{optional=false}={}) {
    const result=spawnSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:65536});
    if(result.error)throw result.error;
    if(result.status!==0) {
        if(optional&&result.status===1)return null;
        throw new Error(result.stderr.trim()||'Не удалось настроить Git-хуки проекта.');
    }
    return result.stdout.trim();
}

async function hookDirectory(root) {
    const directory=path.join(git(root,['rev-parse','--path-format=absolute','--git-common-dir']),'neurocenter-hooks');
    try {
        const info=await lstat(directory);
        if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Каталог Git-хуков занят посторонними данными.');
    } catch(error) {if(error.code!=='ENOENT')throw error;}
    return directory;
}

async function installation(directory) {
    try {
        const file=path.join(directory,'installation.json'),info=await lstat(file);
        if(!info.isFile()||info.isSymbolicLink()||info.size>16384)throw new Error('Некорректная регистрация Git-хуков.');
        const value=JSON.parse(await readFile(file,'utf8'));
        if(value.marker!==marker||value.previousLocal!==null&&typeof value.previousLocal!=='string'
            ||typeof value.previousDirectory!=='string'||!path.isAbsolute(value.previousDirectory)
            ||value.previousRelative!==undefined&&(typeof value.previousRelative!=='string'||path.isAbsolute(value.previousRelative)))throw new Error('Некорректная регистрация Git-хуков.');
        return value;
    } catch(error) {if(error.code==='ENOENT')return null;throw error;}
}

/** Хуки активируются только в этом репозитории; linked worktrees используют общую регистрацию Git. */
export async function installAssetHooks({root,node=process.execPath,onlyIfInstalled=false}) {
    root=path.resolve(root);
    const directory=await hookDirectory(root);
    const current=git(root,['config','--local','--get','core.hooksPath'],{optional:true});
    const owns=current===directory;
    if(onlyIfInstalled&&!owns)return {ok:true,installed:false};
    const saved=await installation(directory);
    if(owns&&!saved)throw new Error('Не найдена регистрация действующих Git-хуков Нейроцентра.');
    const effective=git(root,['config','--path','--get','core.hooksPath'],{optional:true});
    const previousDirectory=effective===null
        ? path.join(git(root,['rev-parse','--path-format=absolute','--git-common-dir']),'hooks')
        : path.resolve(root,effective);
    const state=owns?{...saved}:{marker,previousLocal:current,previousDirectory,
        ...(effective!==null&&!path.isAbsolute(effective)?{previousRelative:effective}:{})};
    if(owns&&state.previousRelative===undefined&&state.previousLocal!==null) {
        const previous=git(root,['-c',`core.hooksPath=${state.previousLocal}`,'config','--path','--get','core.hooksPath']);
        if(!path.isAbsolute(previous))state.previousRelative=previous;
    }
    if(state.previousDirectory===directory)throw new Error('Цепочка Git-хуков ссылается сама на себя.');
    await mkdir(directory,{mode:0o700,recursive:true});
    for(const hook of hooks) {
        const file=path.join(directory,hook);
        const previous=state.previousRelative===undefined?quote(path.join(state.previousDirectory,hook))
            : `"$(git rev-parse --show-toplevel)"/${quote(path.join(state.previousRelative,hook))}`;
        const shell=['post-merge','post-checkout','post-rewrite'].includes(hook)
            ? `#!/bin/sh\n# ${marker}\nrepo=$(git rev-parse --show-toplevel) || exit 1\nif [ ! -f "$repo/scripts/assets/git-hook.mjs" ]; then\n  printf '%s\\n' 'В этой версии нет загрузчика поставки; проверьте модели перед запуском.' >&2\n  if [ -x ${previous} ]; then exec ${previous} "$@"; fi\n  exit 0\nfi\n${nodeBootstrap(root,node)}exec "$node_bin" "$repo/scripts/assets/git-hook.mjs" ${quote(hook)} "$@"\n`
            : `#!/bin/sh\n# ${marker}\nif [ -x ${previous} ]; then exec ${previous} "$@"; fi\nexit 0\n`;
        await replaceHookFile(file,shell,0o700);
    }
    await replaceHookFile(path.join(directory,'installation.json'),JSON.stringify(state)+'\n',0o600);
    if(!owns)git(root,['config','--local','core.hooksPath',directory]);
    return {ok:true,installed:true,previousDirectory:state.previousDirectory};
}

/** Удаление настройки возвращает прежний local/global hooksPath, не удаляя чужие файлы. */
export async function uninstallAssetHooks({root}) {
    const directory=await hookDirectory(root),saved=await installation(directory);
    if(git(root,['config','--local','--get','core.hooksPath'],{optional:true})!==directory)return {ok:true,installed:false};
    if(!saved)throw new Error('Нельзя восстановить прежние Git-хуки без регистрации.');
    if(saved.previousLocal===null)git(root,['config','--local','--unset','core.hooksPath']);
    else git(root,['config','--local','core.hooksPath',saved.previousLocal]);
    return {ok:true,installed:false};
}

/** Прежние проверки коммитов и push сохраняют своё поведение после установки загрузчика. */
export async function runPreviousHook({root,hook,args,environment=process.env}) {
    if(!hooks.includes(hook))throw new Error('Неизвестный Git-хук.');
    const saved=await installation(await hookDirectory(root));
    if(!saved)return 0;
    const filename=path.resolve(root,saved.previousRelative??saved.previousDirectory,hook);
    try {await access(filename,constants.X_OK);}
    catch(error) {if(['ENOENT','ENOTDIR','EACCES'].includes(error.code))return 0;throw error;}
    const result=spawnSync(filename,args,{cwd:root,env:environment,stdio:'inherit'});
    if(result.error)throw result.error;
    return result.status??1;
}

export const shouldSyncAfterHook=(hook,args)=>hook==='post-merge'
    ||hook==='post-checkout'&&args[2]==='1'||hook==='post-rewrite'&&args[0]==='rebase';
