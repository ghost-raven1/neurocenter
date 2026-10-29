import {expect,it,vi} from 'vitest';
import {createGgufImportController,initialGgufImport} from '../src/features/GgufImport/controller';
import {ggufJournal} from '../src/features/GgufImport/journal';
import {fakeApi,id,imported,key,memoryStorage,policy,receipt} from './gguf-import.fixture';

function fixture(saved=false){
    const storage=memoryStorage(),journal=ggufJournal(storage,'alice/main/api');if(saved)journal.write(key,null);
    const api=fakeApi(),onImported=vi.fn(),access={enabled:true,allowed:true,scope:1};let value=initialGgufImport();
    const make=()=>createGgufImportController({api,journal,uuid:()=>key,enabled:()=>access.enabled,canWrite:()=>access.allowed,captureOwner:()=>{const scope=access.scope;return()=>scope===access.scope;},onChange:next=>{value=next;},onImported});
    const controller=make();return {controller,make,storage,journal,api,onImported,access,get value(){return value;},start:async()=>{controller.activate();await vi.waitFor(()=>expect(value.phase).toBe('idle'));},file:()=>new File(['gguf'],'owned.gguf')};
}

it('fresh policy is checked before admission, preserving selected file when the administrator lowers the limit',async()=>{
    const f=fixture();await f.start();f.controller.selectFile(f.file());f.api.limits.mockResolvedValueOnce({...policy,maximumBytes:2});await f.controller.upload();
    expect(f.value.error).toContain('Размер');expect(f.value.file?.name).toBe('owned.gguf');expect(f.api.create).not.toHaveBeenCalled();expect(f.journal.read()).toBeNull();f.controller.dispose();
});
it('passes the same File as raw upload, then accepts one existing model record with no inference claim',async()=>{
    const f=fixture();await f.start();const file=f.file();f.controller.selectFile(file);await f.controller.upload();
    expect(f.api.upload).toHaveBeenCalledWith(id,file,expect.any(AbortSignal),expect.any(Function));expect(f.value.receipt?.state).toBe('READY');expect(f.onImported).not.toHaveBeenCalled();
    f.controller.change('name','Название');await f.controller.accept();expect(f.api.accept).toHaveBeenCalledWith(id,{name:'Название',description:'',capability:'chat'},expect.any(AbortSignal));expect(f.onImported).toHaveBeenCalledOnce();expect(f.value.receipt?.modelId).toBe('model-gguf-'+id);f.controller.dispose();
});
it('reload recovers create ACK loss with only its UUID and asks for the same local file',async()=>{
    const f=fixture();await f.start();f.controller.selectFile(f.file());f.api.create.mockRejectedValueOnce(Error('ACK lost'));await f.controller.upload();
    expect(f.journal.read()).toBe(key);expect([...f.storage.map.values()]).toEqual([JSON.stringify({version:1,requestKey:key})]);expect(f.api.upload).not.toHaveBeenCalled();f.controller.dispose();
    f.api.lookup.mockResolvedValue(receipt());const restored=f.make();restored.activate();await vi.waitFor(()=>expect(f.value.receipt?.id).toBe(id));await vi.waitFor(()=>expect(f.value.phase).toBe('idle'));
    expect(f.value.file).toBeUndefined();restored.selectFile(new File(['same'],'other.gguf'));expect(f.value.error).toContain('owned.gguf');expect(f.value.file).toBeUndefined();
    restored.selectFile(f.file());await restored.upload();expect(f.api.create).toHaveBeenCalledOnce();expect(f.api.upload).toHaveBeenCalledOnce();restored.dispose();
});
it('lost upload and accept ACKs recover by receipt without retransmission, including feature OFF',async()=>{
    const f=fixture();await f.start();f.controller.selectFile(f.file());f.api.upload.mockRejectedValueOnce(Error('upload ACK lost'));await f.controller.upload();
    f.api.lookup.mockResolvedValue(receipt('READY'));await f.controller.recover();expect(f.value.receipt?.state).toBe('READY');expect(f.api.upload).toHaveBeenCalledOnce();
    f.controller.change('name','Keep this name');f.api.accept.mockRejectedValueOnce({response:{status:403}});await f.controller.accept();expect(f.value.acceptLocked).toBe(true);expect(f.value.name).toBe('Keep this name');
    f.access.enabled=false;f.api.lookup.mockResolvedValue(receipt('ACCEPTED'));await f.controller.recover();expect(f.value.receipt?.state).toBe('ACCEPTED');expect(f.onImported).toHaveBeenCalledOnce();expect(f.api.accept).toHaveBeenCalledOnce();expect(f.journal.read()).toBe(key);f.controller.dispose();
});
it('an admitted upload uses its snapshotted limits when current settings are unavailable',async()=>{
    const f=fixture(true);f.api.lookup.mockResolvedValue({...receipt(),limits:{...policy,maximumBytes:4}});f.api.upload.mockResolvedValueOnce({...receipt('READY'),limits:{...policy,maximumBytes:4}});f.api.limits.mockRejectedValue(Error('Settings offline'));await f.start();
    expect(f.value.limitsError).toContain('Settings offline');f.controller.selectFile(f.file());await f.controller.upload();expect(f.value.receipt?.state).toBe('READY');expect(f.api.limits).toHaveBeenCalledOnce();f.controller.dispose();
});
it('cancel aborts a held upload and its late READY response cannot undo the confirmed cancellation',async()=>{
    const f=fixture();await f.start();f.controller.selectFile(f.file());let resolve!:(value:unknown)=>void;
    f.api.upload.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));const uploading=f.controller.upload();await vi.waitFor(()=>expect(f.api.upload).toHaveBeenCalledOnce());
    const signal=f.api.upload.mock.calls[0][2];f.api.lookup.mockResolvedValue(receipt('UPLOADING'));await f.controller.cancel();expect(signal.aborted).toBe(true);expect(f.value.receipt?.state).toBe('CANCELLED');
    resolve(receipt('READY'));await uploading;expect(f.value.receipt?.state).toBe('CANCELLED');expect(f.onImported).not.toHaveBeenCalled();f.controller.dispose();
});
it('revoking and restoring grants fences a late ACK but preserves the principal receipt for a new scope',async()=>{
    const f=fixture();await f.start();f.controller.selectFile(f.file());let resolve!:(value:unknown)=>void;
    f.api.upload.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));const uploading=f.controller.upload();await vi.waitFor(()=>expect(f.api.upload).toHaveBeenCalledOnce());
    f.access.scope++;f.controller.dispose();resolve(receipt('READY'));await uploading;expect(f.value.receipt?.state).not.toBe('READY');expect(f.journal.read()).toBe(key);
    f.api.lookup.mockResolvedValue(receipt('READY'));const restored=f.make();restored.activate();await vi.waitFor(()=>expect(f.value.receipt?.state).toBe('READY'));expect(f.api.upload).toHaveBeenCalledOnce();expect(f.value.file).toBeUndefined();restored.dispose();
});
it('corrupt journal is retained and blocks all requests and new UUID writes',async()=>{
    const f=fixture();const name='neurocenter:gguf-import:v1:'+encodeURIComponent('alice/main/api');f.storage.setItem(name,'{broken');await f.start();
    expect(f.value.journalError).toContain('повреждён');await f.controller.upload();await f.controller.cancel();expect(f.storage.getItem(name)).toBe('{broken');expect(f.api.limits).not.toHaveBeenCalled();expect(f.api.create).not.toHaveBeenCalled();f.controller.dispose();
});
it('a malformed receipt or model ACK cannot publish a different import',async()=>{
    const f=fixture(true);f.api.lookup.mockResolvedValue({...receipt('READY'),requestKey:'33333333-3333-4333-8333-333333333333'});await f.start();expect(f.value.receipt).toBeUndefined();expect(f.value.error).toContain('Квитанция');
    f.api.lookup.mockResolvedValue(receipt('READY'));await f.controller.recover();f.api.accept.mockResolvedValue({...imported(),id:'model-foreign'});await f.controller.accept();expect(f.value.error).toContain('Карточка');expect(f.onImported).not.toHaveBeenCalled();expect(f.journal.read()).toBe(key);f.controller.dispose();
});
it('feature OFF blocks raw/accept admission while read and cancellation stay available',async()=>{
    const f=fixture(true);f.api.lookup.mockResolvedValue(receipt('READY'));await f.start();f.access.enabled=false;await f.controller.accept();expect(f.api.accept).not.toHaveBeenCalled();await f.controller.recover();await f.controller.cancel();expect(f.api.cancel).toHaveBeenCalledOnce();expect(f.value.receipt?.state).toBe('CANCELLED');f.controller.dispose();
});
it('server 409 leaves the editable name for a deliberate retry with the same upload ID',async()=>{
    const f=fixture(true);f.api.lookup.mockResolvedValue(receipt('READY'));await f.start();f.controller.change('name','Taken');f.api.accept.mockRejectedValueOnce({response:{status:409}});await f.controller.accept();expect(f.value.acceptLocked).toBe(false);
    f.controller.change('name','Available');await f.controller.accept();expect(f.api.accept.mock.calls.map(call=>call[0])).toEqual([id,id]);expect(f.api.accept.mock.calls[1][1].name).toBe('Available');f.controller.dispose();
});
it('another tab cannot have its newer journal cleared by a terminal receipt from this tab',async()=>{
    const f=fixture(true);f.api.lookup.mockResolvedValue(receipt('CANCELLED'));await f.start();const next='33333333-3333-4333-8333-333333333333';f.journal.write(next,key);f.controller.reset();expect(f.journal.read()).toBe(next);expect(f.value.error).toContain('другой вкладке');f.controller.dispose();
});
it('a later missing receipt removes a stale READY claim while retaining the request UUID',async()=>{
    const f=fixture(true);f.api.lookup.mockResolvedValueOnce(receipt('READY'));await f.start();expect(f.value.receipt?.state).toBe('READY');
    f.api.lookup.mockRejectedValueOnce({response:{status:404}});await f.controller.recover();expect(f.value.receipt).toBeUndefined();expect(f.value.missing).toBe(true);expect(f.journal.read()).toBe(key);
    f.api.lookup.mockResolvedValueOnce(receipt());await f.controller.recover();expect(f.value.receipt).toBeUndefined();expect(f.value.error).toContain('Состояние');f.controller.dispose();
});
it('checking an import does not restore a filename default over an intentionally empty name draft',async()=>{
    const f=fixture(true);f.api.lookup.mockResolvedValue(receipt('READY'));await f.start();f.controller.change('name','');await f.controller.recover();expect(f.value.name).toBe('');f.controller.dispose();
});
it('reset and reactivation replace the whole state instead of retaining optional model or File fields',async()=>{
    const f=fixture(true);f.api.lookup.mockResolvedValue(receipt('ACCEPTED'));await f.start();expect(f.value.model?.id).toBe('model-gguf-'+id);
    f.controller.reset();expect(f.value.key).toBeNull();expect(f.value.receipt).toBeUndefined();expect(f.value.model).toBeUndefined();expect(f.value.file).toBeUndefined();
    f.controller.selectFile(f.file());expect(f.value.file).toBeDefined();f.controller.dispose();f.controller.activate();await vi.waitFor(()=>expect(f.value.phase).toBe('idle'));expect(f.value.file).toBeUndefined();f.controller.dispose();
});
