import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {generateKit,repositoryRoot} from '../generate.mjs';

const core='.opencode/skills/neurocenter-task-flow';
const firstSkill='.opencode/skills/neurocenter-task-orchestrator/SKILL.md';
const lastAdapter='scripts/agent-kit/codex/neurocenter-cleanup-refactor.toml';
const common=['SKILL.md','agents/openai.yaml','references/interface.md','references/roles.md','references/verification.md','references/neurocenter.md','references/development-debugging.md','references/codex.md','references/opencode.md'];
const hash=value=>createHash('sha256').update(value).digest('hex');

async function put(root,relative,content){
    const file=path.join(root,relative);
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,content);
}

/** Copy only catalogue inputs and shared instructions into an owned disposable project. */
async function fixture(t){
    const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'nc-agent-kit-generate-')));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    await fs.cp(path.join(repositoryRoot,'scripts/agent-kit/roles'),path.join(root,'scripts/agent-kit/roles'),{recursive:true});
    for(const name of common)await put(root,core+'/'+name,await fs.readFile(path.join(repositoryRoot,core,name)));
    await put(root,'.opencode/commands/neurocenter-task.md',await fs.readFile(path.join(repositoryRoot,'.opencode/commands/neurocenter-task.md')));
    return root;
}

/** Observe bytes, metadata and links without following a directory supplied by the fixture. */
async function snapshot(root){
    const entries={};
    async function visit(directory,prefix=''){
        const children=await fs.readdir(directory,{withFileTypes:true});
        for(const entry of children.sort((a,b)=>a.name.localeCompare(b.name))){
            const relative=prefix?prefix+'/'+entry.name:entry.name;
            const file=path.join(directory,entry.name);
            const stat=await fs.lstat(file,{bigint:true});
            entries[relative]={mode:String(stat.mode),mtime:String(stat.mtimeNs),value:entry.isFile()?hash(await fs.readFile(file)):entry.isSymbolicLink()?await fs.readlink(file):'directory'};
            if(entry.isDirectory())await visit(file,relative);
        }
    }
    await visit(root);
    return entries;
}

test('check reports all absent outputs without creating any project file',async t=>{
    const root=await fixture(t),before=await snapshot(root);
    const result=await generateKit({root,checkOnly:true});
    assert.equal(result.roles,64);
    assert.equal(result.skills,65);
    assert.equal(result.generatedFiles,193);
    assert.equal(result.checkedFiles,203);
    assert.equal(result.changed.length,194);
    assert.deepEqual(await snapshot(root),before);
});

test('a generated project passes check without rewriting files or manifest',async t=>{
    const root=await fixture(t);
    await generateKit({root});
    const before=await snapshot(root);
    assert.deepEqual((await generateKit({root,checkOnly:true})).changed,[]);
    assert.deepEqual(await snapshot(root),before);
});

test('a manual conflict in the final adapter prevents every earlier planned write',async t=>{
    const root=await fixture(t);
    await put(root,lastAdapter,'name = "personal-role"\n');
    const before=await snapshot(root);
    await assert.rejects(generateKit({root}),/Сохранён изменённый файл/);
    assert.deepEqual(await snapshot(root),before);
});

test('a modified owned skill blocks an unrelated update and preserves the whole project',async t=>{
    const root=await fixture(t);
    await generateKit({root});
    await put(root,firstSkill,'Personal changes to an installed skill\n');
    const catalogue=path.join(root,'scripts/agent-kit/roles/backend.json');
    const roles=JSON.parse(await fs.readFile(catalogue));
    roles[0].outcome+=' Уточнённый результат.';
    await fs.writeFile(catalogue,JSON.stringify(roles));
    const before=await snapshot(root);
    await assert.rejects(generateKit({root}),/Сохранён изменённый файл/);
    assert.deepEqual(await snapshot(root),before);
});

test('an owned catalogue update changes its dependent outputs and preserves manual neighbours',async t=>{
    const root=await fixture(t);
    await generateKit({root});
    await put(root,'.opencode/agents/personal-agent.md','My unrelated agent\n');
    const catalogue=path.join(root,'scripts/agent-kit/roles/backend.json');
    const roles=JSON.parse(await fs.readFile(catalogue));
    roles[0].outcome+=' Уточнённый результат.';
    await fs.writeFile(catalogue,JSON.stringify(roles));
    const before=await snapshot(root);
    const result=await generateKit({root});
    assert.deepEqual(new Set(result.changed),new Set([
        '.opencode/skills/neurocenter-backend-architect/SKILL.md',
        'scripts/agent-kit/codex/neurocenter-backend-architect.toml',
        'scripts/agent-kit/manifest.json',
    ]));
    const after=await snapshot(root);
    for(const [relative,state]of Object.entries(before)){
        if(state.value!=='directory'&&!result.changed.includes(relative))assert.deepEqual(after[relative],state,relative);
    }
    assert.deepEqual((await generateKit({root,checkOnly:true})).changed,[]);
});

test('duplicate role identifiers are rejected before generation starts',async t=>{
    const root=await fixture(t);
    const catalogue=path.join(root,'scripts/agent-kit/roles/backend.json');
    const roles=JSON.parse(await fs.readFile(catalogue));
    roles[0].id=roles[1].id;
    await fs.writeFile(catalogue,JSON.stringify(roles));
    const before=await snapshot(root);
    await assert.rejects(generateKit({root}),/64 уникальные роли/);
    assert.deepEqual(await snapshot(root),before);
});

for(const checkOnly of [true,false])test(`reserved task-flow role cannot replace the shared workflow in ${checkOnly?'check':'apply'} mode`,async t=>{
    const root=await fixture(t);await generateKit({root});
    const catalogue=path.join(root,'scripts/agent-kit/roles/backend.json');
    const roles=JSON.parse(await fs.readFile(catalogue));roles[0].id='task-flow';
    await fs.writeFile(catalogue,JSON.stringify(roles));
    const before=await snapshot(root);
    await assert.rejects(generateKit({root,checkOnly}),/task-flow.*зарезервирован/);
    assert.deepEqual(await snapshot(root),before);
});

test('a generated leaf symlink is rejected before writing any planned output',async t=>{
    const root=await fixture(t);
    await put(root,'foreign/sentinel','Leave this file unchanged\n');
    await fs.mkdir(path.join(root,'.opencode/agents'),{recursive:true});
    await fs.symlink(path.join(root,'foreign/sentinel'),path.join(root,'.opencode/agents/neurocenter-task-orchestrator.md'));
    const before=await snapshot(root);
    await assert.rejects(generateKit({root}),/Небезопасный путь набора/);
    assert.deepEqual(await snapshot(root),before);
});

test('a parent directory symlink is rejected before creating foreign or earlier outputs',async t=>{
    const root=await fixture(t);
    await put(root,'foreign/sentinel','Leave this directory unchanged\n');
    await fs.symlink(path.join(root,'foreign'),path.join(root,'.opencode/agents'));
    const before=await snapshot(root);
    await assert.rejects(generateKit({root}),/Небезопасный путь набора/);
    assert.deepEqual(await snapshot(root),before);
    assert.deepEqual(await fs.readdir(path.join(root,'foreign')),['sentinel']);
    await assert.rejects(fs.stat(path.join(root,firstSkill)),{code:'ENOENT'});
});

async function renamedRole(t){
    const root=await fixture(t);await generateKit({root});
    const catalogue=path.join(root,'scripts/agent-kit/roles/backend.json');
    const roles=JSON.parse(await fs.readFile(catalogue));roles[0].id='backend-architect-renamed';
    await fs.writeFile(catalogue,JSON.stringify(roles));
    return {root,obsolete:['.opencode/skills/neurocenter-backend-architect/SKILL.md','.opencode/agents/neurocenter-backend-architect.md','scripts/agent-kit/codex/neurocenter-backend-architect.toml']};
}

test('a role rename plans and retires only still-owned old outputs, then becomes idempotent',async t=>{
    const {root,obsolete}=await renamedRole(t);
    const manual='.opencode/skills/neurocenter-backend-architect/notes.md';await put(root,manual,'Personal notes\n');
    const before=await snapshot(root),planned=await generateKit({root,checkOnly:true});
    assert.deepEqual(new Set(planned.obsolete),new Set(obsolete));assert.deepEqual(await snapshot(root),before);
    const result=await generateKit({root});assert.deepEqual(result.obsolete,planned.obsolete);
    for(const name of obsolete)await assert.rejects(fs.stat(path.join(root,name)),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(root,manual),'utf8'),'Personal notes\n');
    const manifest=JSON.parse(await fs.readFile(path.join(root,'scripts/agent-kit/manifest.json')));
    for(const name of obsolete)assert.equal(Object.hasOwn(manifest.files,name),false);
    const after=await snapshot(root);assert.deepEqual((await generateKit({root})).obsolete,[]);
    assert.deepEqual((await generateKit({root,checkOnly:true})).changed,[]);assert.deepEqual(await snapshot(root),after);
});

for(const conflict of ['modified','link','parent link'])test(`an obsolete ${conflict} prevents every generation write`,async t=>{
    const {root,obsolete}=await renamedRole(t),target=path.join(root,obsolete[0]);
    if(conflict==='modified')await fs.writeFile(target,'My obsolete role\n');
    else{
        await put(root,'foreign/SKILL.md',await fs.readFile(target));
        if(conflict==='link'){await fs.unlink(target);await fs.symlink(path.join(root,'foreign/SKILL.md'),target);}
        else{await fs.rm(path.dirname(target),{recursive:true});await fs.symlink(path.join(root,'foreign'),path.dirname(target));}
    }
    const before=await snapshot(root);
    await assert.rejects(generateKit({root}),/изменённый устаревший файл|Небезопасный путь набора/);
    assert.deepEqual(await snapshot(root),before);
});

test('missing obsolete outputs retire their ownership without blocking a role rename',async t=>{
    const {root,obsolete}=await renamedRole(t);await fs.unlink(path.join(root,obsolete[0]));
    assert.deepEqual(new Set((await generateKit({root})).obsolete),new Set(obsolete));
    assert.deepEqual((await generateKit({root,checkOnly:true})).obsolete,[]);
});

test('a prior manifest cannot authorize retirement outside generated role paths',async t=>{
    const {root}=await renamedRole(t),file=path.join(root,'scripts/agent-kit/manifest.json');
    await put(root,'personal.md','Manual file\n');const manifest=JSON.parse(await fs.readFile(file));manifest.files['personal.md']=hash('Manual file\n');
    await fs.writeFile(file,JSON.stringify(manifest));const before=await snapshot(root);
    await assert.rejects(generateKit({root}),/Некорректный прежний manifest/);assert.deepEqual(await snapshot(root),before);
});

test('disabled retirement still plans obsolete files and blocks every generation write until re-enabled',async t=>{
    const {root,obsolete}=await renamedRole(t),environment={NEUROCENTER_AGENT_KIT_RETIRE:'0'};
    await put(root,'.opencode/skills/neurocenter-backend-architect/notes.md','Personal notes\n');
    await fs.unlink(path.join(root,obsolete[1]));
    const before=await snapshot(root),plan=await generateKit({root,checkOnly:true,environment});
    assert.equal(plan.retirementEnabled,false);assert.deepEqual(new Set(plan.obsolete),new Set(obsolete));
    await assert.rejects(generateKit({root,environment}),/NEUROCENTER_AGENT_KIT_RETIRE=0/);
    assert.deepEqual(await snapshot(root),before);
    const applied=await generateKit({root,environment:{NEUROCENTER_AGENT_KIT_RETIRE:'1'}});
    assert.equal(applied.retirementEnabled,true);assert.deepEqual(new Set(applied.obsolete),new Set(obsolete));
    const after=await snapshot(root);assert.deepEqual((await generateKit({root})).obsolete,[]);
    assert.deepEqual(await snapshot(root),after);
});

test('disabled retirement permits generation and updates without obsolete owned paths',async t=>{
    const root=await fixture(t),environment={NEUROCENTER_AGENT_KIT_RETIRE:'0'};
    assert.equal((await generateKit({root,environment})).retirementEnabled,false);
    await put(root,core+'/references/interface.md','Updated shared instructions\n');
    assert.deepEqual((await generateKit({root,environment})).changed,['scripts/agent-kit/manifest.json']);
    assert.deepEqual((await generateKit({root,checkOnly:true,environment})).changed,[]);
});

test('invalid retirement flags are rejected before filesystem access and preserve the entire project',async t=>{
    const root=await fixture(t),before=await snapshot(root);let pathCalls=0;
    const inaccessibleRoot={toString(){pathCalls++;throw Error('Filesystem input must not be used');}};
    for(const value of ['', 'true', '2', '01', ' 1', '1 ', 1, null]){
        const environment={NEUROCENTER_AGENT_KIT_RETIRE:value};
        await assert.rejects(generateKit({root:inaccessibleRoot,environment}),/NEUROCENTER_AGENT_KIT_RETIRE must be 0 or 1/);
        await assert.rejects(generateKit({root,environment}),/NEUROCENTER_AGENT_KIT_RETIRE must be 0 or 1/);
    }
    assert.equal(pathCalls,0);assert.deepEqual(await snapshot(root),before);
});
