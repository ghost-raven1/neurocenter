// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useAgentMethodWorkflow} from '../src/features/AgentMethods/useAgentMethodWorkflow';
import {readWorkflowDraft,workflowStorageKey,workflowResult} from '../src/features/AgentMethods/model';

const io=vi.hoisted(()=>({create:vi.fn(),request:vi.fn()}));
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:io}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:'qa-owner',captureOwner:()=>()=>true})}));
let value:ReturnType<typeof useAgentMethodWorkflow>,root:Root,container:HTMLDivElement;
function Probe(){value=useAgentMethodWorkflow('prj-qa');return createElement('span',null,value.error);}
const render=async()=>{await act(async()=>{root.render(createElement(Probe));});};
const target={deviceId:'device',expectedBindingId:'a'.repeat(64),expectedInstanceId:'11111111-1111-4111-8111-111111111111'};
beforeEach(()=>{vi.resetAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);localStorage.clear();container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});

it('persists before dispatch, survives reload and repeats the same intent after a confirmed missing receipt',async()=>{
    io.create.mockImplementationOnce(async()=>{
        expect(readWorkflowDraft(localStorage,workflowStorageKey('qa-owner','prj-qa')).pending).toBeDefined();throw Error('HTTP503');
    });
    await render();await act(async()=>{value.update({instruction:'QA task'});});await act(async()=>{await value.start(target);});
    const original=io.create.mock.calls[0][0];expect(value.draft.pending?.requestKey).toBe(original.requestKey);
    await act(async()=>root.unmount());root=createRoot(container);await render();expect(value.draft.pending).toEqual(original);
    await act(async()=>{await value.start(target);});expect(io.create).toHaveBeenCalledTimes(1);
    io.request.mockRejectedValueOnce({response:{status:404}});await act(async()=>{await value.recover();});expect(value.canReplay).toBe(true);
    io.create.mockResolvedValueOnce({id:'accepted',kind:original.kind,workflowId:original.requestKey,deviceId:target.deviceId,projectId:'prj-qa',bindingId:target.expectedBindingId,expectedInstanceId:target.expectedInstanceId});
    await act(async()=>{await value.replay();});expect(io.create.mock.calls[1][0]).toEqual(original);expect(value.draft.pending).toBeUndefined();expect(value.draft.instruction).toBe('QA task');
});

it('storage failure prevents dispatch and preserves typed input',async()=>{
    await render();await act(async()=>{value.update({instruction:'Keep this task'});});
    const save=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('quota');});
    await act(async()=>{await value.start(target);});expect(io.create).not.toHaveBeenCalled();expect(value.draft.instruction).toBe('Keep this task');expect(value.storageError).toContain('сохранить');save.mockRestore();
});

it('rejects a receipt for another folder without clearing the original recovery intent',async()=>{
    await render();await act(async()=>{value.update({instruction:'Original task'});});
    io.create.mockResolvedValueOnce({id:'wrong',kind:'run-agent-method-workflow',deviceId:'device',projectId:'prj-qa',bindingId:'b'.repeat(64),expectedInstanceId:target.expectedInstanceId});
    await act(async()=>{await value.start(target);});expect(value.draft.pending).toBeDefined();expect(value.accepted).toBeUndefined();expect(value.error).toContain('папку');
});

it('editing cannot overwrite an unreadable pending intent or unlock a new dispatch',async()=>{
    const key=workflowStorageKey('qa-owner','prj-qa'),corrupt='{"method":"openspec","pending":';localStorage.setItem(key,corrupt);
    await render();expect(value.storageError).toContain('заблокирована');
    await act(async()=>{value.update({instruction:'New intent must wait'});await value.start(target);});
    expect(localStorage.getItem(key)).toBe(corrupt);expect(value.storageError).toContain('заблокирована');expect(io.create).not.toHaveBeenCalled();
});

it('incomplete recovery targets use the explicit damaged-copy path without replaying a rejected request',async()=>{
    const key=workflowStorageKey('qa-owner','prj-qa');localStorage.setItem(key,JSON.stringify({method:'openspec',instruction:'Old task',checks:['test'],pending:{kind:'run-agent-method-workflow',projectId:'prj-qa',requestKey:'22222222-2222-4222-8222-222222222222',workflow:{method:'openspec',instruction:'Old task',checks:[{command:'npm',args:['test']}]}}}));
    await render();expect(value.damaged).toBe(true);expect(value.storageError).toBeTruthy();
    await act(async()=>{await value.replay();});expect(io.create).not.toHaveBeenCalled();
});

it('retains a pasted task when saving fails and can retry saving without sending it',async()=>{
    await render();const save=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('quota');});
    await act(async()=>{value.update({instruction:'Preserve this pasted input'});});expect(value.draft.instruction).toBe('Preserve this pasted input');expect(value.storageError).toBeTruthy();
    await act(async()=>{await value.start(target);});expect(io.create).not.toHaveBeenCalled();
    save.mockRestore();await act(async()=>{value.retrySave();});expect(value.storageError).toBe('');expect(value.draft.instruction).toBe('Preserve this pasted input');expect(io.create).not.toHaveBeenCalled();
});

it('keeps an oversized Russian draft across reload while refusing dispatch by UTF8 byte count',async()=>{
    const text='я'.repeat(9000);await render();await act(async()=>{value.update({instruction:text});});
    await act(async()=>root.unmount());root=createRoot(container);await render();expect(value.draft.instruction).toBe(text);expect(value.damaged).toBe(false);
    await act(async()=>{await value.start(target);});expect(io.create).not.toHaveBeenCalled();expect(value.draft.instruction).toBe(text);
});

it('can explicitly replace a rejected stale binding only after a missing receipt, preserving the task',async()=>{
    io.create.mockRejectedValueOnce({response:{status:409}});await render();await act(async()=>{value.update({instruction:'Keep task after folder changed'});});
    await act(async()=>{await value.start(target);});const first=io.create.mock.calls[0][0];expect(value.canDiscard).toBe(false);
    io.request.mockRejectedValueOnce({response:{status:404}});await act(async()=>{await value.recover();});expect(value.canDiscard).toBe(true);
    await act(async()=>{value.discardRejected();});expect(value.draft.pending).toBeUndefined();expect(value.draft.instruction).toBe('Keep task after folder changed');
    const fresh={...target,expectedBindingId:'b'.repeat(64)};io.create.mockImplementationOnce(async input=>({id:'fresh',kind:input.kind,workflowId:input.requestKey,projectId:input.projectId,deviceId:input.deviceId,bindingId:input.expectedBindingId,expectedInstanceId:input.expectedInstanceId}));
    await act(async()=>{await value.start(fresh);});expect(io.create.mock.calls[1][0].requestKey).not.toBe(first.requestKey);expect(io.create.mock.calls[1][0].expectedBindingId).toBe(fresh.expectedBindingId);
});

it('does not discard an unknown POST outcome after a missing receipt',async()=>{
    io.create.mockRejectedValueOnce({response:{status:503}});await render();await act(async()=>{value.update({instruction:'Unknown acceptance'});});await act(async()=>{await value.start(target);});
    io.request.mockRejectedValueOnce({response:{status:404}});await act(async()=>{await value.recover();});expect(value.canReplay).toBe(true);
    await act(async()=>{value.discardRejected();});expect(value.canDiscard).toBe(false);expect(value.draft.pending).toBeDefined();
});

it('does not interpret an incomplete result as successful execution',()=>{
    expect(workflowResult({protocol:'agent-method-workflow-v1',state:'succeeded'})).toBeUndefined();
    expect(workflowResult({protocol:'agent-method-workflow-v1',method:'openspec',state:'succeeded',stage:'completed',changes:[],artifacts:[],checks:[{command:'npm',args:['test'],state:'failed',exitCode:1,signal:null}]})).toBeUndefined();
});
