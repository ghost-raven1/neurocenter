import {expect,it,vi} from 'vitest';
import base from '../src/core/api/base';
import {ggufImportApi} from '../src/features/GgufImport/api';
import {ggufJournal} from '../src/features/GgufImport/journal';
import {readReceipt} from '../src/features/GgufImport/model';
import {key,memoryStorage,policy,receipt} from './gguf-import.fixture';

it('sends browser File unchanged as octet-stream with abort/progress and no local whole-file conversion',async()=>{
    const file=new File(['gguf'],'model.gguf'),arrayBuffer=vi.fn(()=>{throw Error('Whole-file read forbidden');});Object.defineProperty(file,'arrayBuffer',{value:arrayBuffer});
    const spy=vi.spyOn(base,'put').mockResolvedValueOnce({data:{state:'READY'}}),controller=new AbortController(),progress=vi.fn();
    await ggufImportApi.upload('upload/id',file,controller.signal,progress);
    expect(spy).toHaveBeenCalledWith('/api/models/gguf-imports/upload%2Fid/content',file,expect.objectContaining({signal:controller.signal,timeout:0,headers:{'Content-Type':'application/octet-stream'}}));
    const config=spy.mock.calls[0][2]!;expect((config.transformRequest as ((body:unknown)=>unknown)[])[0](file)).toBe(file);config.onUploadProgress!({loaded:3} as never);expect(progress).toHaveBeenCalledWith(3);expect(arrayBuffer).not.toHaveBeenCalled();spy.mockRestore();
});
it('journal principals are isolated and malformed contents are not silently replaced',()=>{
    const storage=memoryStorage(),alice=ggufJournal(storage,'alice-api'),bob=ggufJournal(storage,'bob-api');alice.write(key,null);expect(bob.read()).toBeNull();expect(()=>bob.clear(key)).toThrow();
    const journalKey=[...storage.map.keys()][0];storage.setItem(journalKey,JSON.stringify({version:1,requestKey:key,fileBytes:'forbidden'}));expect(()=>alice.write(key,null)).toThrow();expect(storage.getItem(journalKey)).toContain('fileBytes');
});
it('an admitted receipt cannot silently change its limits or the SHA of an already verified file',()=>{
    expect(()=>readReceipt({...receipt('READY'),limits:{...policy,maximumBytes:999}},key,receipt())).toThrow();
    expect(()=>readReceipt({...receipt('READY'),sha256:'b'.repeat(64)},key,receipt('READY'))).toThrow();
});
it('receipt states cannot regress after READY, cancellation or catalog acceptance',()=>{
    for(const [before,after]of [['READY','WAITING'],['READY','UPLOADING'],['CANCELLED','READY'],['CANCELLED','WAITING'],['ACCEPTED','READY'],['ACCEPTED','WAITING']] as const){
        expect(()=>readReceipt(receipt(after),key,receipt(before)),before+' -> '+after).toThrow();
    }
    expect(readReceipt(receipt('WAITING'),key,receipt('UPLOADING')).state).toBe('WAITING');
});
