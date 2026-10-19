import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {hydrateModelBundle} from './bundle.mjs';
import {validateModelBundle} from './bundle-manifest.mjs';
import {validateModelRegistry} from './model-registry.mjs';
import {adoptManagedModelBundle} from './bundle-managed.mjs';

const execute=promisify(execFile),metadataRoot='scripts/models';
const failure=()=>Object.assign(new Error('Не удалось подтвердить прежнюю поставку из истории Git. Нужен доступный commit-предок HEAD с полной описью; теги и SHA локальных весов должны точно совпасть. Данные сохранены.'),{code:'MODEL_GIT_ADOPTION'});

/** Git только читает объекты; скрипты, настройки и веса из прежнего commit не исполняются. */
async function git(root,args,maxBuffer=2*1024**2) {
    const result=await execute('git',args,{cwd:root,maxBuffer,encoding:'utf8',timeout:30000});return result.stdout;
}

async function trackedJson(root,commit,filename,{optional=false}={}) {
    const entries=await git(root,['ls-tree',commit,'--',filename],4096);
    if(!entries.trim()) {if(optional)return undefined;throw failure();}
    // Symlink в Git также является blob: режим проверяется до чтения JSON.
    const entry=/^100(?:644|755) blob [a-f0-9]{40,64}\t([^\n]+)\n$/.exec(entries);
    if(!entry||entry[1]!==filename)throw failure();
    return JSON.parse(await git(root,['show',`${commit}:${filename}`]));
}

/** Подтверждает управление лишь прежним закреплённым комплектом, реально находящимся в проекте. */
export async function adoptModelBundleFromGit({root,directory,reference,onProgress=()=>{}}) {
    if(typeof reference!=='string'||!(/^(?:[a-f0-9]{7,64}|ORIG_HEAD)$/i.test(reference)))throw failure();
    root=path.resolve(root);directory=path.resolve(directory);
    let commit,manifest,locks;
    try {
        commit=(await git(root,['rev-parse','--verify','--end-of-options',`${reference}^{commit}`],4096)).trim();
        if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))throw failure();
        await git(root,['merge-base','--is-ancestor',commit,'HEAD'],4096);
        manifest=await trackedJson(root,commit,`${metadataRoot}/bundle-release.json`);
        const registry=await trackedJson(root,commit,`${metadataRoot}/model-registry.json`,{optional:true});
        if(registry!==undefined) {
            validateModelRegistry(registry);
            locks=await Promise.all(registry.models.map(async item=>{
                const filename=path.posix.normalize(`${metadataRoot}/${item.lock}`),lock=await trackedJson(root,commit,filename);
                if(lock.model!==item.descriptor.model||lock.manifestSha256!==item.descriptor.manifestSha256)throw failure();
                return lock;
            }));
        } else locks=await Promise.all(['scripts/embedding/model.lock.json','scripts/vision/model.lock.json'].map(filename=>trackedJson(root,commit,filename)));
        validateModelBundle(manifest,locks);
    }catch{throw failure();}
    // verifyOnly не создаёт каталоги и квитанции, не обращается в сеть и не восстанавливает незавершённую смену.
    await hydrateModelBundle({directory,manifest,locks,verifyOnly:true,onProgress});
    if(!await adoptManagedModelBundle(directory,manifest.files.filter(file=>file.inlineBase64),{sourceCommit:commit}))throw failure();
    return {ok:true,adopted:true,sourceCommit:commit,models:locks.length,files:manifest.files.length};
}
