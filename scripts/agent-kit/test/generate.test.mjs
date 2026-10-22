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
const common=['SKILL.md','agents/openai.yaml','references/interface.md','references/roles.md','references/verification.md','references/neurocenter.md','references/codex.md','references/opencode.md'];
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
    assert.equal(result.checkedFiles,202);
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
