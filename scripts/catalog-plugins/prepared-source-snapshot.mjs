import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../../',import.meta.url));
/** Public build inputs only. Adding a producer/helper requires deliberately extending this retained source set. */
export const PREPARED_SOURCE_INPUTS=Object.freeze([
    'package.json','package-lock.json',
    'scripts/catalog-plugins/archive-source.mjs','scripts/catalog-plugins/build.mjs','scripts/catalog-plugins/generic.mjs',
    'scripts/catalog-plugins/manifest.mjs','scripts/catalog-plugins/pack.mjs','scripts/catalog-plugins/payload-description.mjs','scripts/catalog-plugins/prepare.mjs',
    'scripts/catalog-plugins/prepared-source-snapshot.mjs','scripts/catalog-plugins/publish.mjs','scripts/catalog-plugins/recipe-schema.mjs',
    'scripts/catalog-plugins/release-inspection.mjs','scripts/catalog-plugins/repository-source.mjs',
    'scripts/catalog-plugins/python-runtime.mjs','scripts/catalog-plugins/python-dependencies.mjs','scripts/catalog-plugins/python-trusted-archive.mjs','scripts/catalog-plugins/python-inspection.mjs',
    'scripts/catalog-plugins/retain-supply.mjs','scripts/catalog-plugins/supply-layout.mjs',
    'scripts/catalog-plugins/run.mjs','scripts/catalog-plugins/runtime-source.mjs','scripts/catalog-plugins/source-adapters.mjs',
    'scripts/catalog-plugins/source-envelope.mjs','scripts/catalog-plugins/source-resource-validation.mjs','scripts/catalog-plugins/upload-inspection.mjs',
    'scripts/catalog-plugins/plugins/git-context.mjs','scripts/catalog-plugins/plugins/project-context.mjs',
    'scripts/catalog-plugins/recipes/fetch-mcp.mjs','scripts/catalog-plugins/recipes/opencode-rag.mjs',
    'scripts/catalog-plugins/recipes/opencode-rag-plugin.mjs','scripts/catalog-plugins/recipes/opencode-snip.mjs',
    'scripts/catalog-plugins/recipes/codex-bridge.mjs','scripts/catalog-plugins/locks/codex-bridge.json',
    ...['codex-plugin.mjs','codex-setup.mjs','codex-executable.mjs'].map(name=>'scripts/catalog-plugins/recipes/adapters/'+name),
    ...['codex-connector-pin.json','codex-connector-source.cjs','codex-connector-source.d.cts'].map(name=>'services/shared/'+name),
    'scripts/catalog-plugins/recipes/rag-managed-pipeline.mjs','scripts/catalog-plugins/recipes/rag-web-ui.mjs','scripts/catalog-plugins/recipes/upstream.mjs',
    ...['opencode-rag.mjs','rag-context.mjs','rag-errors.mjs','rag-hosted.mjs','rag-index-lock.mjs','rag-index-profile.mjs',
        'rag-local-runtime.mjs','rag-mcp.mjs','rag-plugin.mjs','rag-plugin-config.mjs','rag-plugin-errors.mjs',
        'rag-reindex.mjs','rag-reindex-source.mjs','rag-ui.mjs','rag-ui-config.mjs','rag-ui-guards.mjs','snip-plugin.mjs']
        .map(name=>'scripts/catalog-plugins/recipes/adapters/'+name),
    ...['filesystem.json','memory.json','opencode-rag.json','opencode-rag-plugin.json','sequential-thinking.json']
        .map(name=>'scripts/catalog-plugins/locks/'+name),
    'scripts/opencode-platforms.mjs','scripts/workspace/node-runtime.mjs','scripts/models/bundle-files.mjs','scripts/release-request.mjs',
    ...['archive-source.cjs','dependency-pins.cjs','github-release-source.cjs','opencode-rag-source.cjs','rag-index-contract.cjs',
        'rag-ui-contract.cjs','repository-source.cjs','runtime-artifacts.cjs','source-candidates.cjs','source-entrypoint.cjs','tool-runtime-source.cjs']
        .map(name=>'services/shared/'+name),
    ...['dependency-pins.d.cts','rag-ui-contract.d.cts','runtime-artifacts.d.cts','source-entrypoint.d.cts'].map(name=>'services/shared/'+name),
    'services/catalog-service/package.json','services/catalog-service/package-lock.json','services/catalog-service/tsconfig.json',
    'services/catalog-service/tsconfig.build.json','services/catalog-service/src/catalog/dto.ts',
    'services/catalog-service/src/devices/mcp-config-schema.ts','services/catalog-service/src/publication/publication-runtime.ts',
    'services/catalog-service/src/publication/publication-validation.ts',
    'services/shared/tool-supply-paths.cjs','services/shared/tool-supply-paths.d.cts','services/shared/skill-source.mjs',
    'services/shared/python-runtime-pins.cjs','services/shared/python-runtime-pins.d.cts','services/shared/python-source-plan.cjs','services/shared/python-source-plan.d.cts',
].sort());
const stamp=value=>[value.dev,value.ino,value.size,value.mtimeNs,value.ctimeNs].map(String).join(':');

/** Retain the actual UTF-8 source bytes, with the same bounded public-file budget as local source snapshots. */
export async function capturePreparedSource(repositoryRoot=root){
    const directory=await fs.realpath(repositoryRoot),files=[],seen=[];let total=0;
    if(PREPARED_SOURCE_INPUTS.length>100)throw new Error('Prepared source snapshot превышает 100 публичных файлов.');
    for(const relative of PREPARED_SOURCE_INPUTS){
        let current=directory;
        for(const segment of relative.split('/').slice(0,-1)){current=path.join(current,segment);const info=await fs.lstat(current);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Prepared source snapshot содержит ссылку или специальный путь.');}
        const filename=path.join(directory,relative),handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try{
            const before=await handle.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.size>1048576n)throw new Error('Prepared source snapshot: нужны обычные публичные файлы до 1 МиБ.');
            const bytes=await handle.readFile(),content=bytes.toString('utf8'),identity=stamp(before);total+=bytes.length;
            if(bytes.includes(0)||!Buffer.from(content).equals(bytes)||total>5*1048576)throw new Error('Prepared source snapshot: UTF-8 без NUL и до 5 МиБ.');
            if(stamp(await handle.stat({bigint:true}))!==identity||stamp(await fs.lstat(filename,{bigint:true}))!==identity)throw new Error('Prepared source snapshot изменился во время чтения.');
            files.push({path:relative,content});seen.push([filename,identity]);
        }finally{await handle.close();}
    }
    for(const [filename,identity] of seen)if(stamp(await fs.lstat(filename,{bigint:true}))!==identity)throw new Error('Prepared source snapshot изменился во время чтения.');
    return {files,revision:createHash('sha256').update(JSON.stringify(seen.map(([filename,identity])=>[path.relative(directory,filename),identity]))).digest('hex')};
}
export async function preparedSourceFiles(repositoryRoot=root){return (await capturePreparedSource(repositoryRoot)).files;}
