// @vitest-environment jsdom
import {createHash,webcrypto} from 'node:crypto';
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useAgentMethodWorkflow} from '../src/features/AgentMethods/useAgentMethodWorkflow';
import {readWorkflowDraft,workflowStorageKey} from '../src/features/AgentMethods/model';

const io=vi.hoisted(()=>({create:vi.fn(),request:vi.fn()}));
const scope=JSON.stringify({id:'owner',email:'qa@example.test',activeRole:'Админ проекта'});
let currentScope=scope;
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:io}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:currentScope,captureOwner:()=>()=>true})}));
const origin={roomId:'00000000-0000-0000-0000-000000000000',messageId:'22222222-2222-4222-8222-222222222222'};
const target={deviceId:'device',expectedBindingId:'a'.repeat(64),expectedInstanceId:'11111111-1111-4111-8111-111111111111'};
const agent={agentId:'agent-review',slug:'nc-reviewer',version:2,agentsRevision:4,agentsManifestSha256:'b'.repeat(64),compiledManifestSha256:'c'.repeat(64),fileSha256:'d'.repeat(64),configurationJobId:'33333333-3333-4333-8333-333333333333'};
const fingerprint=(input:object)=>createHash('sha256').update(JSON.stringify({role:'Админ проекта',request:Object.entries(input).sort(([a],[b])=>a.localeCompare(b))})).digest('hex');
let value:ReturnType<typeof useAgentMethodWorkflow>,root:Root,container:HTMLDivElement;
let selectedOrigin=origin,initialInstruction='Исходное сообщение';
function Probe(){value=useAgentMethodWorkflow('prj-qa',{origin:selectedOrigin,initialInstruction});return createElement('span',null,value.error);}
const render=async()=>{await act(async()=>root.render(createElement(Probe)));};
const remount=async()=>{await act(async()=>root.unmount());root=createRoot(container);await render();};
beforeEach(()=>{vi.resetAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('crypto',webcrypto);localStorage.clear();currentScope=scope;selectedOrigin=origin;initialInstruction='Исходное сообщение';container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});

it('isolates message drafts from the catalog and other sources, applying source text only to an absent draft',async()=>{
    localStorage.setItem(workflowStorageKey(scope,'prj-qa'),JSON.stringify({method:'openspec',instruction:'Каталог',checks:['test']}));
    await render();expect(value.draft.instruction).toBe('Исходное сообщение');
    await act(async()=>value.update({instruction:'Мой уточнённый план'}));initialInstruction='Не подменять сохранённый ввод';await remount();expect(value.draft.instruction).toBe('Мой уточнённый план');
    selectedOrigin={...origin,messageId:'44444444-4444-4444-8444-444444444444'};await remount();expect(value.draft.instruction).toBe(initialInstruction);
    expect(JSON.parse(localStorage.getItem(workflowStorageKey(scope,'prj-qa'))!).instruction).toBe('Каталог');expect(io.create).not.toHaveBeenCalled();
});

it('persists the exact selected origin and digest before dispatch and confirms it through the server receipt',async()=>{
    await render();await act(async()=>value.update({agentId:agent.agentId}));
    io.create.mockImplementationOnce(async input=>{const raw=JSON.parse(localStorage.getItem(workflowStorageKey(scope,'prj-qa',origin))!);expect(raw.pending).toEqual(input);expect(raw.pendingFingerprint).toBe(fingerprint(input));return {id:'accepted'};});
    io.request.mockImplementationOnce(async requestKey=>{const input=io.create.mock.calls[0][0];return {requestKey,requestFingerprint:fingerprint(input),job:{id:'accepted',kind:input.kind,workflowId:requestKey,deviceId:input.deviceId,projectId:input.projectId,bindingId:input.expectedBindingId,expectedInstanceId:input.expectedInstanceId,agent}};});
    await act(async()=>value.start(target,4));expect(io.create).toHaveBeenCalledOnce();expect(io.create.mock.calls[0][0].workflow.origin).toEqual(origin);
    expect(io.request).toHaveBeenCalledExactlyOnceWith(io.create.mock.calls[0][0].requestKey);expect(value.draft.pending).toBeUndefined();expect(value.accepted?.id).toBe('accepted');
});

it('keeps an unknown scoped request across reload and refuses a different origin fingerprint',async()=>{
    await render();await act(async()=>value.update({agentId:agent.agentId}));io.create.mockRejectedValueOnce(Error('Lost ACK'));await act(async()=>value.start(target,4));const original=io.create.mock.calls[0][0];
    await remount();expect(value.draft.pending).toEqual(original);
    const job={id:'wrong-source',kind:original.kind,workflowId:original.requestKey,deviceId:target.deviceId,projectId:'prj-qa',bindingId:target.expectedBindingId,expectedInstanceId:target.expectedInstanceId,agent};
    io.request.mockResolvedValueOnce({requestKey:original.requestKey,requestFingerprint:'f'.repeat(64),job});await act(async()=>value.recover());expect(value.draft.pending).toEqual(original);expect(value.accepted).toBeUndefined();
    io.request.mockRejectedValueOnce({response:{status:404}});await act(async()=>value.recover());expect(value.canReplay).toBe(true);
    io.create.mockRejectedValueOnce(Error('ACK lost again'));await act(async()=>value.replay());expect(io.create.mock.calls[1][0]).toEqual(original);
});

it('blocks agentless origin admission and rejects a copied recovery intent from another message',async()=>{
    await render();await act(async()=>value.start(target));expect(io.create).not.toHaveBeenCalled();
    await act(async()=>value.update({agentId:agent.agentId}));io.create.mockRejectedValueOnce(Error('Lost ACK'));await act(async()=>value.start(target,4));
    const key=workflowStorageKey(scope,'prj-qa',origin),raw=localStorage.getItem(key)!;selectedOrigin={...origin,messageId:'44444444-4444-4444-8444-444444444444'};
    localStorage.setItem(workflowStorageKey(scope,'prj-qa',selectedOrigin),raw);await remount();expect(value.damaged).toBe(true);expect(value.storageError).toBeTruthy();
    expect(()=>readWorkflowDraft({getItem:()=>raw},'qa','prj-qa',selectedOrigin)).toThrow();
});

it('retains a long durable source while requiring a shorter execution instruction',async()=>{
    initialInstruction='я'.repeat(60000);await render();await act(async()=>value.update({agentId:agent.agentId}));await remount();
    expect(value.damaged).toBe(false);expect(value.draft.instruction).toBe(initialInstruction);await act(async()=>value.start(target,4));expect(io.create).not.toHaveBeenCalled();
});

it('keeps exact acceptance recovery after a role downgrade while separating another person',async()=>{
    await render();await act(async()=>value.update({agentId:agent.agentId}));io.create.mockRejectedValueOnce(Error('Lost ACK'));await act(async()=>value.start(target,4));const original=io.create.mock.calls[0][0];
    currentScope=JSON.stringify({id:'owner',email:'qa@example.test',activeRole:'Наблюдатель'});await remount();expect(value.draft.pending).toEqual(original);
    io.request.mockImplementationOnce(async()=>({requestKey:original.requestKey,requestFingerprint:fingerprint(original),job:{id:'accepted',kind:original.kind,workflowId:original.requestKey,deviceId:original.deviceId,projectId:original.projectId,bindingId:original.expectedBindingId,expectedInstanceId:original.expectedInstanceId,agent}}));
    await act(async()=>value.recover());expect(value.accepted?.id).toBe('accepted');expect(value.draft.pending).toBeUndefined();
    currentScope=JSON.stringify({id:'other',email:'qa@example.test',activeRole:'Админ проекта'});await remount();expect(value.draft.agentId).toBeUndefined();expect(io.create).toHaveBeenCalledTimes(1);
});
