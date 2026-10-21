import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {useAssetArchiveUpload} from '../src/features/AssetSources/useAssetArchiveUpload';
import {assetArchiveError,ASSET_ARCHIVE_MAX_BYTES} from '../src/features/AssetSources/archiveUpload';
import type {ISourceList} from '../src/features/AssetSources/types';

const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
    const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(value,a[index]));
    return {begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        useState:(initial:unknown)=>{const slot=slots[cursor++]??={value:initial};return [slot.value,(next:unknown)=>{slot.value=typeof next==='function'?next(slot.value):next;}];},
        useRef:(initial:unknown)=>(slots[cursor++]??={value:{current:initial}}).value,
        useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>{const index=cursor++,previous=slots[index];if(previous&&same(previous.deps,deps))return;const slot=slots[index]={deps};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});},
    };
});
const io=vi.hoisted(()=>({scope:'admin',owners:new Map<string,()=>()=>boolean>(),put:vi.fn(),blocked:false,start:vi.fn(),finish:vi.fn(),success:vi.fn()}));
vi.mock('react',()=>({...hooks}));
vi.mock('../src/core/api',()=>({baseApi:{put:io.put}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{
    if(!io.owners.has(io.scope)){const scope=io.scope;io.owners.set(scope,()=>()=>io.scope===scope);}
    return {scope:io.scope,captureOwner:io.owners.get(io.scope)!};
}}));
const data:ISourceList={source:{repository:'ghost-raven1/neurocenter-assets',commit:'a'.repeat(40),verified:true,archiveSha256:'b'.repeat(64)},assets:[]};
const file=()=>new File(['archive-content'],'delivery.zip',{type:'application/zip'});
function render(){hooks.begin();const value=useAssetArchiveUpload({blocked:()=>io.blocked,onStart:io.start,onFinish:io.finish,onSuccess:io.success});hooks.commit();return value;}
async function flush(){for(let n=0;n<10;n++)await Promise.resolve();}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};}
beforeEach(()=>{vi.resetAllMocks();io.scope='admin';io.owners.clear();io.blocked=false;io.put.mockResolvedValue({data});});
afterEach(()=>hooks.dispose());

describe('Raw archive upload',()=>{
    it('Передаёт сам File без multipart/base64 и возвращает проверенный список',async()=>{
        render();const archive=file();expect(await render().upload(archive)).toBe(true);
        expect(io.put).toHaveBeenCalledExactlyOnceWith('/api/asset-sources/archive',archive,expect.objectContaining({signal:expect.any(AbortSignal),headers:{'Content-Type':'application/octet-stream'},onUploadProgress:expect.any(Function)}));
        expect(io.start).toHaveBeenCalledOnce();expect(io.success).toHaveBeenCalledExactlyOnceWith(data);expect(io.finish).toHaveBeenCalledOnce();expect(render()).toMatchObject({busy:false,percent:100,error:''});
    });
    it('Показывает передачу и отдельный этап проверки сервера',async()=>{
        render();const pending=deferred<{data:ISourceList}>();io.put.mockReturnValue(pending.promise);const archive=file(),upload=render().upload(archive);
        const progress=io.put.mock.calls[0][2].onUploadProgress;progress({loaded:Math.floor(archive.size/2)});expect(render()).toMatchObject({stage:'uploading',busy:true,percent:46});
        progress({loaded:archive.size});expect(render()).toMatchObject({stage:'validating',busy:true,percent:100});expect(io.success).not.toHaveBeenCalled();pending.resolve({data});await upload;
    });
    it('Повторный клик не создаёт второй PUT; после завершения тот же архив разрешён',async()=>{
        render();const pending=deferred<{data:ISourceList}>();io.put.mockReturnValueOnce(pending.promise);const upload=render().upload(file());expect(await render().upload(file())).toBe(false);expect(io.put).toHaveBeenCalledOnce();
        pending.resolve({data});await upload;expect(await render().upload(file())).toBe(true);expect(io.put).toHaveBeenCalledTimes(2);
    });
    it('Активный импорт или редактор блокирует передачу',async()=>{
        io.blocked=true;render();expect(await render().upload(file())).toBe(false);expect(io.put).not.toHaveBeenCalled();expect(io.start).not.toHaveBeenCalled();
    });
    it('Ошибка сервера сохраняет список у владельца страницы и разрешает повтор',async()=>{
        render();io.put.mockRejectedValueOnce(new Error('Архив повреждён'));expect(await render().upload(file())).toBe(false);expect(render()).toMatchObject({busy:false,error:'Архив повреждён'});expect(io.success).not.toHaveBeenCalled();expect(io.finish).toHaveBeenCalledOnce();
        expect(await render().upload(file())).toBe(true);expect(render().error).toBe('');
    });
    it.each(['uploading','validating'])('Отмена прерывает %s и отсекает поздний успех/прогресс',async stage=>{
        render();const pending=deferred<{data:ISourceList}>();io.put.mockReturnValue(pending.promise);const archive=file(),upload=render().upload(archive),config=io.put.mock.calls[0][2];if(stage==='validating')config.onUploadProgress({loaded:archive.size});
        render().cancel();expect(config.signal.aborted).toBe(true);config.onUploadProgress({loaded:archive.size});pending.resolve({data});expect(await upload).toBe(false);expect(render()).toMatchObject({busy:false,stage:'idle',percent:0,error:''});expect(io.success).not.toHaveBeenCalled();expect(io.finish).toHaveBeenCalledOnce();
    });
    it('Unmount прерывает запрос и поздняя ошибка не вызывает callbacks',async()=>{
        render();const pending=deferred<{data:ISourceList}>();io.put.mockReturnValue(pending.promise);const upload=render().upload(file()),signal=io.put.mock.calls[0][2].signal;hooks.dispose();expect(signal.aborted).toBe(true);pending.reject(new Error('Поздняя ошибка'));await upload;expect(io.success).not.toHaveBeenCalled();expect(io.finish).not.toHaveBeenCalled();
    });
    it.each(['success','failure'])('Смена владельца и возврат не принимает старый ответ и не снимает lock нового запроса: %s',async outcome=>{
        render();const old=deferred<{data:ISourceList}>(),next=deferred<{data:ISourceList}>();io.put.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);const previous=render().upload(file()),oldConfig=io.put.mock.calls[0][2];
        io.scope='developer';render();io.scope='admin';render();const current=render().upload(file());expect(oldConfig.signal.aborted).toBe(true);
        oldConfig.onUploadProgress({loaded:100});if(outcome==='success')old.resolve({data});else old.reject(new Error('Старая ошибка'));await previous;expect(render()).toMatchObject({busy:true,stage:'uploading',error:''});expect(io.success).not.toHaveBeenCalled();expect(io.finish).not.toHaveBeenCalled();
        next.resolve({data});await current;expect(io.success).toHaveBeenCalledOnce();expect(io.finish).toHaveBeenCalledOnce();
    });
});
describe('Archive selection boundary',()=>{
    it.each(['source.zip','source.TAR','source.tar.gz','source.tgz'])('Принимает %s без анализа MIME',name=>expect(assetArchiveError(new File(['x'],name))).toBe(''));
    it.each(['source.json','source.zip.exe','source.gz'])('Отклоняет %s до PUT',async name=>{render();expect(await render().upload(new File(['x'],name))).toBe(false);expect(render().error).toContain('ZIP');expect(io.put).not.toHaveBeenCalled();});
    it('Пустой и слишком большой файл не отправляются; точная граница 8 ГиБ допустима',async()=>{
        render();expect(await render().upload(new File([],'empty.zip'))).toBe(false);expect(render().error).toContain('пуст');
        const large=file();Object.defineProperty(large,'size',{value:ASSET_ARCHIVE_MAX_BYTES+1});expect(await render().upload(large)).toBe(false);expect(render().error).toContain('8 ГиБ');expect(io.put).not.toHaveBeenCalled();
        const exact=file();Object.defineProperty(exact,'size',{value:8*1024**3});expect(assetArchiveError(exact)).toBe('');
    });
});
