import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {doctorKit} from '../doctor.mjs';
import {generateKit,repositoryRoot} from '../generate.mjs';
import {installCodexKit} from '../install-codex.mjs';

const expectedTools=['first_tool','second_tool'];
const core='.opencode/skills/neurocenter-task-flow';
const common=['SKILL.md','agents/openai.yaml','references/interface.md','references/roles.md','references/verification.md','references/neurocenter.md','references/development-debugging.md','references/codex.md','references/opencode.md'];
const installedRole='agents/neurocenter-task-orchestrator.toml';
const hash=value=>createHash('sha256').update(value).digest('hex');

async function put(root,relative,content){
    const file=path.join(root,relative);
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,content);
}

/** Use the real generator and installer only inside disposable kit and Codex directories. */
async function fixture(t,{installed=true}={}){
    const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'nc-agent-kit-doctor-')));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const kitRoot=path.join(root,'kit'),codexHome=path.join(root,'codex');
    await fs.cp(path.join(repositoryRoot,'scripts/agent-kit/roles'),path.join(kitRoot,'scripts/agent-kit/roles'),{recursive:true});
    for(const name of common)await put(kitRoot,core+'/'+name,await fs.readFile(path.join(repositoryRoot,core,name)));
    await put(kitRoot,'.opencode/commands/neurocenter-task.md','Project task command\n');
    await generateKit({root:kitRoot});
    if(installed)installCodexKit({kitRoot,codexHome,apply:true});
    const run=options=>doctorKit({kitRoot,codexHome,expectedTools,...options});
    const cli=async args=>{
        for(const name of ['doctor.mjs','generate.mjs','install-codex.mjs','contracts.mjs'])await put(kitRoot,'scripts/agent-kit/'+name,await fs.readFile(new URL('../'+name,import.meta.url)));
        await put(kitRoot,'scripts/dev-mcp/tool-catalog.mjs','export const expectedToolNames='+JSON.stringify(expectedTools)+';\nexport const toolFlags=(env=process.env)=>({checkPlanEnabled:env.NEUROCENTER_DEV_MCP_CHECK_PLAN!=="0"});\nexport const toolDefinitions=({checkPlanEnabled=true}={})=>expectedToolNames.filter(name=>checkPlanEnabled||name!=="second_tool").map(name=>({name}));\n');
        return spawnSync(process.execPath,[path.join(kitRoot,'scripts/agent-kit/doctor.mjs'),...args],{env:{...process.env,CODEX_HOME:codexHome,NEUROCENTER_DEV_MCP_CHECK_PLAN:'1'},encoding:'utf8'});
    };
    return {root,kitRoot,codexHome,run,cli};
}

/** Compare all fixture bytes, links and modification metadata to detect accidental writes. */
async function snapshot(root){
    const entries={};
    async function visit(directory,prefix=''){
        for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
            const relative=prefix?prefix+'/'+entry.name:entry.name,file=path.join(directory,entry.name),stat=await fs.lstat(file,{bigint:true});
            entries[relative]={mode:String(stat.mode),mtime:String(stat.mtimeNs),value:entry.isFile()?hash(await fs.readFile(file)):entry.isSymbolicLink()?await fs.readlink(file):'directory'};
            if(entry.isDirectory())await visit(file,relative);
        }
    }
    await visit(root);
    return entries;
}

test('a matching installation leaves live discovery unknown and does not write any files',async t=>{
    const f=await fixture(t);
    await fs.symlink(path.join(f.root,'private-config-must-not-be-read'),path.join(f.codexHome,'config.toml'));
    await put(f.codexHome,'auth.json','private account data must not appear in diagnostics\n');
    const before=await snapshot(f.root),result=await f.run();
    assert.equal(result.status,'unverified');
    assert.equal(result.repository.status,'pass');
    assert.equal(result.installedCopy.status,'pass');
    assert.equal(result.installedCopy.roles,64);
    assert.equal(result.installedCopy.skills,65);
    assert.equal(result.observedClient.status,'unknown');
    assert.equal(result.observedClient.evidence,'not-supplied');
    assert.equal(result.roleContracts.roles,64);assert.equal(result.roleContracts.effectivePermissions,'unknown');
    assert.equal(result.roleContracts.loadedRoles,'unverified');assert.equal(result.roleContracts.generated.status,'pass');
    assert.equal(result.roleContracts.installed.status,'pass');assert.match(result.roleContracts.source.sha256,/^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(result),/private account|private-config|nc-agent-kit-doctor-/);
    assert.deepEqual(await snapshot(f.root),before);
});

test('a catalogue change reports stale generated files independently from an unchanged installation',async t=>{
    const f=await fixture(t),file=path.join(f.kitRoot,'scripts/agent-kit/roles/backend.json');
    const roles=JSON.parse(await fs.readFile(file));
    roles[0].outcome+=' Новый результат.';
    await fs.writeFile(file,JSON.stringify(roles));
    const before=await snapshot(f.root),result=await f.run();
    assert.equal(result.status,'mismatch');
    assert.equal(result.repository.status,'mismatch');
    assert.ok(result.repository.changed.includes('scripts/agent-kit/manifest.json'));
    assert.equal(result.installedCopy.status,'pass');
    assert.deepEqual(await snapshot(f.root),before);
});

test('source tampering is reported without exposing source contents or rewriting either copy',async t=>{
    const f=await fixture(t);
    await put(f.kitRoot,'scripts/agent-kit/codex/neurocenter-task-orchestrator.toml','private prompt contents\n');
    const before=await snapshot(f.root),result=await f.run();
    assert.equal(result.repository.code,'GENERATED_FILE_MODIFIED');
    assert.equal(result.installedCopy.code,'SOURCE_INTEGRITY_MISMATCH');
    assert.doesNotMatch(JSON.stringify(result),/private prompt|nc-agent-kit-doctor-/);
    assert.deepEqual(await snapshot(f.root),before);
});

test('manual installed changes remain intact and are reported separately from valid source',async t=>{
    const f=await fixture(t);
    await put(f.codexHome,installedRole,'A private manual agent prompt\n');
    const before=await snapshot(f.root),result=await f.run();
    assert.equal(result.repository.status,'pass');
    assert.equal(result.installedCopy.status,'mismatch');
    assert.equal(result.installedCopy.code,'INSTALLED_FILE_MODIFIED');
    assert.doesNotMatch(JSON.stringify(result),/private manual|nc-agent-kit-doctor-/);
    assert.deepEqual(await snapshot(f.root),before);
});

/** Rename one fixture role while retaining the required 64-role catalogue. */
async function renameRole(f){
    const file=path.join(f.kitRoot,'scripts/agent-kit/roles/backend.json'),roles=JSON.parse(await fs.readFile(file));
    const previous=roles[0].id;roles[0].id+='-renamed';await fs.writeFile(file,JSON.stringify(roles));
    return {skill:'.opencode/skills/neurocenter-'+previous+'/SKILL.md',agent:'agents/neurocenter-'+previous+'.toml'};
}

test('doctor lists obsolete generated outputs without applying a role rename',async t=>{
    const f=await fixture(t),old=await renameRole(f),before=await snapshot(f.root),result=await f.run();
    assert.equal(result.repository.status,'mismatch');assert.equal(result.repository.obsolete.length,3);
    assert.ok(result.repository.obsolete.includes(old.skill));assert.equal(result.installedCopy.status,'pass');
    assert.deepEqual(await snapshot(f.root),before);
});

test('modified obsolete project output is a bounded ownership conflict and stays intact',async t=>{
    const f=await fixture(t),old=await renameRole(f);await put(f.kitRoot,old.skill,'PRIVATE_OLD_PROJECT_PROMPT\n');
    const before=await snapshot(f.root),result=await f.run();
    assert.equal(result.repository.status,'mismatch');assert.equal(result.repository.code,'GENERATED_OBSOLETE_MODIFIED');
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_OLD_PROJECT_PROMPT|nc-agent-kit-doctor-/);
    assert.deepEqual(await snapshot(f.root),before);
});

test('modified obsolete installed role is reported without exposing or deleting its prompt',async t=>{
    const f=await fixture(t),old=await renameRole(f);await generateKit({root:f.kitRoot});
    await put(f.codexHome,old.agent,'PRIVATE_OLD_INSTALLED_PROMPT\n');
    const before=await snapshot(f.root),result=await f.run();
    assert.equal(result.repository.status,'pass');assert.equal(result.installedCopy.status,'mismatch');
    assert.equal(result.installedCopy.code,'INSTALLED_OBSOLETE_MODIFIED');
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_OLD_INSTALLED_PROMPT|nc-agent-kit-doctor-/);
    assert.deepEqual(await snapshot(f.root),before);
});

test('a missing installation stays absent after the doctor reports it',async t=>{
    const f=await fixture(t,{installed:false}),before=await snapshot(f.root),result=await f.run();
    assert.equal(result.repository.status,'pass');
    assert.equal(result.installedCopy.code,'INSTALLED_COPY_DIFFERS');
    await assert.rejects(fs.stat(f.codexHome),{code:'ENOENT'});
    assert.deepEqual(await snapshot(f.root),before);
});

test('identical installed files without their receipt do not count as a verified installation',async t=>{
    const f=await fixture(t);
    await fs.unlink(path.join(f.codexHome,'neurocenter-agent-kit.json'));
    const before=await snapshot(f.root),result=await f.run();
    assert.equal(result.installedCopy.status,'mismatch');
    assert.equal(result.installedCopy.code,'INSTALLED_COPY_DIFFERS');
    assert.deepEqual(await snapshot(f.root),before);
});

test('tool comparison identifies missing and unexpected public names as caller-supplied evidence',async t=>{
    const f=await fixture(t),before=await snapshot(f.root);
    const result=await f.run({observedTools:['first_tool','older_tool']});
    assert.equal(result.status,'mismatch');
    assert.equal(result.observedClient.evidence,'caller-supplied');
    assert.deepEqual(result.observedClient.missing,['second_tool']);
    assert.deepEqual(result.observedClient.unexpected,['older_tool']);
    assert.equal((await f.run({observedTools:[...expectedTools].reverse()})).status,'pass');
    const declared=await f.run({observedTools:[...expectedTools]});
    assert.equal(declared.roleContracts.effectivePermissions,'unknown');assert.equal(declared.roleContracts.loadedRoles,'unverified');
    assert.deepEqual((await f.run({observedTools:[]})).observedClient.missing,expectedTools);
    assert.deepEqual(await snapshot(f.root),before);
});

test('role diagnostics can be disabled without changing historical file or caller-supplied checks',async t=>{
    const f=await fixture(t),before=await snapshot(f.root);
    const result=await f.run({observedTools:expectedTools,environment:{NEUROCENTER_AGENT_ROLE_CONTRACTS:'0'}});
    assert.equal(result.status,'pass');assert.equal(Object.hasOwn(result,'roleContracts'),false);
    assert.equal(result.repository.status,'pass');assert.equal(result.installedCopy.status,'pass');
    await assert.rejects(f.run({environment:{NEUROCENTER_AGENT_ROLE_CONTRACTS:'yes'}}),/NEUROCENTER_AGENT_ROLE_CONTRACTS/);
    assert.deepEqual(await snapshot(f.root),before);
});

test('malformed source produces a fixed bounded message without parser excerpts',async t=>{
    const f=await fixture(t);
    await put(f.kitRoot,'scripts/agent-kit/roles/backend.json','{"private_prompt":"this must never be echoed"');
    const result=await f.run();
    assert.equal(result.repository.status,'error');
    assert.equal(result.installedCopy.status,'pass');
    assert.doesNotMatch(JSON.stringify(result),/private_prompt|never be echoed|nc-agent-kit-doctor-/);
});

test('invalid tool inputs are rejected before inspecting source or installation',async()=>{
    for(const observedTools of [null,'first_tool',[''],['../auth.json'],['x'.repeat(129)],['first_tool','first_tool'],Array.from({length:129},(_,i)=>'tool_'+i)]){
        await assert.rejects(doctorKit({kitRoot:'/does-not-exist',codexHome:'/does-not-exist',expectedTools,observedTools}),/observedTools must contain/);
    }
    await assert.rejects(doctorKit({kitRoot:'/does-not-exist',expectedTools:['../private']}),/expectedTools must contain/);
});

test('CLI accepts repeated observations, fails real mismatches and leaves unknown discovery successful',async t=>{
    const f=await fixture(t);
    const unknown=await f.cli([]);
    assert.equal(unknown.status,0,unknown.stderr);
    assert.equal(JSON.parse(unknown.stdout).status,'unverified');
    const before=await snapshot(f.root);
    const valid=spawnSync(process.execPath,[path.join(f.kitRoot,'scripts/agent-kit/doctor.mjs'),'--observed-tool','first_tool','--observed-tool','second_tool'],{env:{...process.env,CODEX_HOME:f.codexHome,NEUROCENTER_DEV_MCP_CHECK_PLAN:'1'},encoding:'utf8'});
    assert.equal(valid.status,0,valid.stderr);
    assert.equal(JSON.parse(valid.stdout).observedClient.status,'pass');
    const missing=spawnSync(process.execPath,[path.join(f.kitRoot,'scripts/agent-kit/doctor.mjs'),'--observed-tool','first_tool'],{env:{...process.env,CODEX_HOME:f.codexHome,NEUROCENTER_DEV_MCP_CHECK_PLAN:'1'},encoding:'utf8'});
    assert.equal(missing.status,1);
    assert.deepEqual(JSON.parse(missing.stdout).observedClient.missing,['second_tool']);
    const disabled=spawnSync(process.execPath,[path.join(f.kitRoot,'scripts/agent-kit/doctor.mjs'),'--observed-tool','first_tool'],{env:{...process.env,CODEX_HOME:f.codexHome,NEUROCENTER_DEV_MCP_CHECK_PLAN:'0'},encoding:'utf8'});
    assert.equal(disabled.status,0,disabled.stderr);
    assert.deepEqual(JSON.parse(disabled.stdout).observedClient.expectedTools,['first_tool']);
    assert.deepEqual(await snapshot(f.root),before);
});

test('CLI help and invalid flags do not inspect or create an unavailable Codex home',async t=>{
    const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'nc-agent-kit-doctor-args-')));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const cli=new URL('../doctor.mjs',import.meta.url),codexHome=path.join(root,'missing','codex');
    for(const args of [['--help'],['--unknown'],['--observed-tool'],['--observed-tool','../private'],['--observed-tool','first_tool','--observed-tool','first_tool'],['--help','--observed-tool','first_tool']]){
        const result=spawnSync(process.execPath,[cli.pathname,...args],{env:{...process.env,CODEX_HOME:codexHome},encoding:'utf8'});
        assert.equal(result.status,args.length===1&&args[0]==='--help'?0:1);
        assert.match(result.stdout+result.stderr,/Usage:/);
        assert.doesNotMatch(result.stdout+result.stderr,/nc-agent-kit-doctor-args-/);
    }
    assert.deepEqual(await fs.readdir(root),[]);
});
