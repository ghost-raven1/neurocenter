import {expect,it} from 'vitest';
import {agentToolsSelection,defaultAgentToolsDraft,emptyAgentToolsDraft,restoredAgentToolsDraft} from '../src/features/AgentTools/draft';
import type {AgentToolCapabilities,AgentToolGrant} from '../src/features/AgentTools/types';
const cap: AgentToolCapabilities = {protocol: 'json-actions-v1',available: true,rag: {available: true},systemRoles: {available: true},publicChats: {available: true,models: [{id: 'embedding-one',name: 'Embedding',pin: 'a'.repeat(64),dimension: 3}]},mcp: {available: false,reason: 'MCP unavailable'},limits: {steps: 3,deadlineMs: 120000}};
it('defaults only untouched safe sources and the first eligible model without public consent', () => {
    const value = defaultAgentToolsDraft(emptyAgentToolsDraft(),cap);
    expect(value).toMatchObject({enabled: true,rag: true,systemRoles: true,publicChats: false,consent: false,model: {id: 'embedding-one',pin: 'a'.repeat(64)}});
    expect(agentToolsSelection(value,cap).request).toEqual({protocol: 'json-actions-v1',rag: true,systemRoles: true});
    const manual = {...value,enabled: false,model: undefined,modelTouched: true}; expect(defaultAgentToolsDraft(manual,cap)).toBe(manual);
});
it('retains explicit clear and old model pins on refresh, blocking a changed version until human selection', () => {
    const draft = {...defaultAgentToolsDraft(emptyAgentToolsDraft(),cap),publicChats: true,consent: true,modelTouched: true};
    const changed = {...cap,publicChats: {...cap.publicChats,models: [{...cap.publicChats.models[0],pin: 'b'.repeat(64)}]}};
    expect(defaultAgentToolsDraft(draft,changed)).toBe(draft); expect(agentToolsSelection(draft,changed).reason).toContain('версия');
    const cleared = {...draft,model: undefined,consent: false}; expect(defaultAgentToolsDraft(cleared,cap).model).toBeUndefined(); expect(agentToolsSelection(cleared,cap).request).toBeUndefined();
});
it('restores exact grant including an explicit false and room pin without granting another source', () => {
    const grant: AgentToolGrant = {protocol: 'json-actions-v1',rag: false,systemRoles: false,publicChats: {modelId: 'embedding-one',expectedModelPin: 'a'.repeat(64),consent: true,roomId: '00000000-0000-0000-0000-000000000000'}};
    const restored = restoredAgentToolsDraft(grant); expect(agentToolsSelection(defaultAgentToolsDraft(restored,cap),cap).request).toEqual(grant);
    expect(agentToolsSelection(restored,{...cap,available: false,reason: 'OFF'})).toMatchObject({reason: 'OFF'}); expect(restored.restored).toEqual(grant);
    expect(agentToolsSelection({...restored,restored: undefined,systemRoles: true},cap).request?.publicChats?.roomId).toBe(grant.publicChats?.roomId);
});
