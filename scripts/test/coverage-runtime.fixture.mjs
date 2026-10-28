import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const coverageFiles={
    run:['run.mjs','options.mjs','focused-selection.mjs','unit-safe-profile.mjs','profiles.mjs','owned-pg.mjs','methods.mjs','report.mjs',
        'source-inventory.mjs','source-identity.mjs','test-file-inventory.mjs','inventory-reporter.mjs','package.json'],
    merge:['merge.mjs','profiles.mjs','methods.mjs','report.mjs','source-inventory.mjs','package.json'],
    'owned-pg':['owned-pg.mjs','profiles.mjs','source-inventory.mjs'],
};
const workspaceFiles=['run-lifecycle.mjs','isolated-build-process.mjs','isolated-build-source.mjs'];

/** Copy each shipped entrypoint's dependency closure; fixture-specific collectors and policy stay with callers. */
export async function copyCoverageRuntime(root,entry,{sharedFiles=[]}={}){
    if(!Object.hasOwn(coverageFiles,entry))throw Error('Unknown fixture coverage entrypoint: '+entry);
    const files=[...coverageFiles[entry].map(file=>'scripts/coverage/'+file),...workspaceFiles.map(file=>'scripts/workspace/'+file)];
    if(entry==='run')files.push('scripts/workspace/check-report.mjs');
    if(entry!=='merge')files.push('services/shared/feature-flags.cjs','services/shared/feature-flag-catalog.json');
    files.push(...sharedFiles.map(file=>'services/shared/'+file));
    for(const file of new Set(files)){
        const target=path.join(root,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(repository,file),target);
    }
    const tools=path.join(root,'scripts/coverage');
    if(entry!=='owned-pg')await fs.symlink(await fs.realpath(path.join(repository,'scripts/coverage/node_modules')),path.join(tools,'node_modules'),'dir');
    if(entry==='run'){
        // The real classifier resolves its declared parser from Catalog, including in an isolated runtime copy.
        const catalog=path.join(root,'services/catalog-service');await fs.mkdir(path.join(catalog,'node_modules'),{recursive:true});
        await fs.copyFile(path.join(repository,'services/catalog-service/package.json'),path.join(catalog,'package.json'));
        await fs.symlink(await fs.realpath(path.join(repository,'services/catalog-service/node_modules/typescript')),path.join(catalog,'node_modules/typescript'),'dir');
    }
    return tools;
}
