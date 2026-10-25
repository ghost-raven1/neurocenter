import assert from 'node:assert/strict';
import test from 'node:test';
import {loadRoles,renderRoles} from '../generate.mjs';

const names=['read','execute','write','network','delegate'];

test('all 64 roles have explicit capabilities without claiming effective runtime permission',async()=>{
    const {roleContract}=await import('../contracts.mjs'),roles=await loadRoles();
    assert.equal(roles.length,64);
    for(const role of roles){
        const value=roleContract(role);assert.equal(value.roleId,role.id);assert.equal(value.schemaVersion,1);
        assert.deepEqual(Object.keys(value.effects),names);assert.ok(names.every(name=>typeof value.effects[name]==='boolean'));
        assert.equal(value.enforcement.codex,'instruction-only');assert.equal(value.enforcement.effectivePermissions,'unknown');
        assert.equal(value.enforcement.opencode.mcpEffects,'unverified');assert.equal(value.authority,'user-authorized-task');
        if(role.mode==='read')assert.deepEqual(value.effects,{read:true,execute:false,write:false,network:false,delegate:false});
        assert.equal(value.ownership,'assigned-files-and-resources');assert.equal(value.result.evidence,'observed-artifact-and-revision');
    }
});

test('profile overrides may narrow mode capabilities but cannot escalate a read-only role',async()=>{
    const {roleContract}=await import('../contracts.mjs');
    const role=(await loadRoles()).find(item=>item.id==='reviewer');
    for(const name of names.filter(name=>name!=='read'))assert.throws(()=>roleContract({...role,effects:{[name]:true}}),/escalat|mode|capabilit/i);
    assert.equal(roleContract({...role,effects:{read:false}}).effects.read,false);
    for(const effects of [null,[],{shell:true},{execute:'false'}])assert.throws(()=>roleContract({...role,effects}));
});

test('rendered adapters agree on role capabilities and retain supported platform permission boundaries',async()=>{
    const {roleContract}=await import('../contracts.mjs'),roles=await loadRoles(),files=renderRoles(roles);
    for(const role of roles){
        const expected=roleContract(role).effects;
        for(const file of [`scripts/agent-kit/codex/neurocenter-${role.id}.toml`,`.opencode/agents/neurocenter-${role.id}.md`,`.opencode/skills/neurocenter-${role.id}/SKILL.md`]){
            const value=files.get(file),observed=Object.fromEntries([...value.matchAll(/\b(read|execute|write|network|delegate)=(true|false)\b/g)].map(([,key,flag])=>[key,flag==='true']));
            assert.deepEqual(observed,expected,file);
        }
        const codex=files.get(`scripts/agent-kit/codex/neurocenter-${role.id}.toml`);
        assert.deepEqual(codex.split('\n').filter(line=>/^[a-z_]+\s*=/.test(line)).map(line=>line.split('=')[0].trim()),['name','description','developer_instructions']);
        if(role.mode==='read'){
            const opencode=files.get(`.opencode/agents/neurocenter-${role.id}.md`);
            for(const key of ['edit','bash','task'])assert.match(opencode,new RegExp('  '+key+': deny'));
            assert.match(codex,/instruction-only/);
        }
    }
});

test('role feature flag is strict while disabled diagnostics do not claim role activation',async()=>{
    const {roleContractsEnabled}=await import('../contracts.mjs');
    assert.equal(roleContractsEnabled({}),true);assert.equal(roleContractsEnabled({NEUROCENTER_AGENT_ROLE_CONTRACTS:'0'}),false);
    for(const value of ['', 'yes', '01', '2'])assert.throws(()=>roleContractsEnabled({NEUROCENTER_AGENT_ROLE_CONTRACTS:value}),/NEUROCENTER_AGENT_ROLE_CONTRACTS/);
});
