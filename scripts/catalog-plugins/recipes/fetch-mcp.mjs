import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import bundledCatalog from '../../../services/shared/bundled-catalog.cjs';

const repository = 'https://github.com/zcaceres/fetch-mcp';
const commit = '1ddb1a59cb09a2d38e759f2d7a97829680cbe514';
const entrypoint = 'src/index.ts';
const sourceSha256 = '72a37b4a3d371948d0075184b299fc5d62557ee74f27195f5c57d4214811b4be';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Известный Fetch объявляет ресурсы без обработчика; исправляется только проверенный исходник. */
export async function applyFetchCompatibility(source, directory) {
    if (source.url !== repository || source.commit !== commit || source.entrypoint !== entrypoint
        || source.subdirectory || source.runtimeSource) { return undefined; }
    const filename = path.join(directory, entrypoint);
    const original = await fs.readFile(filename);
    if (hash(original) !== sourceSha256) { throw new Error('Закреплённый исходник Fetch не совпал с ожидаемой SHA-256; исправление не применено.'); }
    const patched = original.toString('utf8').replace('      resources: {},\n', '');
    await fs.writeFile(filename, patched);
    return { id: 'fetch-tools-only-v1', path: entrypoint, sourceSha256, patchedSha256: hash(patched) };
}

/** Approved Fetch source is shipped with the app; only its exact locked npm dependencies need a registry. */
export async function prepareBundledFetch(recipe,context,{prepareProject}){
    const component=await bundledCatalog.readBundledComponent('fetch-mcp');
    const staged=await fs.mkdtemp(path.join(path.dirname(context.directory),'.fetch-source-'));
    try{
        for(const [name,bytes]of component.files){
            if(!name.startsWith('source/'))continue;const filename=path.join(staged,name.slice(7));
            await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,bytes,{flag:'wx'});
        }
        const patch=await applyFetchCompatibility({url:repository,commit,entrypoint},staged);
        const result=await prepareProject({...recipe,source:{type:'project',directory:'.',entrypoint}}, {...context,recipeDirectory:staged});
        return {...result,upstream:{...result.upstream,repository,commit,compatibilityPatches:[patch]}};
    }finally{await fs.rm(staged,{recursive:true,force:true});}
}
