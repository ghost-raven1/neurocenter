import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const source=fileURLToPath(new URL('../../',import.meta.url));

/** Only fixed QA dispatcher entries are replaced; the shipped Node24 selector runs normally. */
async function fixture(t){
    const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'nc qa wrapper ')));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    for(const name of ['scripts/qa/cli.mjs','scripts/workspace/node24-cli.mjs','scripts/workspace/node-runtime.mjs']){
        const target=path.join(root,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(source,name),target);
    }
    for(const name of ['postgres','native'])await fs.writeFile(path.join(root,'scripts/qa',name+'.mjs'),
        "console.log(JSON.stringify({node:process.versions.node,args:process.argv.slice(2)}));process.exitCode=7;");
    const run=args=>spawnSync(process.execPath,[path.join(root,'scripts/qa/cli.mjs'),...args],{
        cwd:root,env:{PATH:path.dirname(process.execPath)+path.delimiter+'/usr/bin:/bin',NODE_BIN:process.execPath},encoding:'utf8',timeout:10000,
    });
    return {root,run};
}

for(const entry of ['postgres','native'])test('QA '+entry+' dispatch retains Node24, exact arguments and failure exit',async t=>{
    const f=await fixture(t),args=['plan','--candidate','a path with spaces'],result=f.run([entry,...args]);
    assert.equal(result.error,undefined);assert.equal(result.status,7,result.stderr);
    const observed=JSON.parse(result.stdout);assert.match(observed.node,/^24\./);assert.deepEqual(observed.args,args);
    await assert.rejects(fs.stat(path.join(f.root,'.run')),{code:'ENOENT'});
});

test('QA dispatcher rejects unknown entries before resolving a command or writing files',async t=>{
    const f=await fixture(t);
    for(const args of [[],['../postgres'],['shell'],['--help']]){
        const result=f.run(args);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/Choose postgres or native/);
    }
    await assert.rejects(fs.stat(path.join(f.root,'.run')),{code:'ENOENT'});
});
