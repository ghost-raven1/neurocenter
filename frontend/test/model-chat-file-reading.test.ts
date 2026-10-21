import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {chatFileBase64,chatFileError,chatFileSize,CHAT_FILE_MAX_BYTES} from '../src/features/ModelChat/files';

/** A controlled browser reader exposes event order without decoding unbounded payloads in tests. */
class BrowserReader {
    static instances:BrowserReader[]=[];static emitAbort=true;
    result:string|ArrayBuffer|null=null;
    onload:(()=>void)|null=null;onerror:(()=>void)|null=null;onabort:(()=>void)|null=null;
    readAsDataURL=vi.fn();
    abort=vi.fn(()=>{if(BrowserReader.emitAbort)this.onabort?.();});
    constructor(){BrowserReader.instances.push(this);}
}
const file={name:'private-note.md',size:12}as File;
beforeEach(()=>{BrowserReader.instances=[];BrowserReader.emitAbort=true;vi.stubGlobal('FileReader',BrowserReader);});
afterEach(()=>vi.unstubAllGlobals());

describe('Чтение документа для личной загрузки',()=>{
    it('Возвращает только base64, читает выбранный File и снимает abort listener после успеха',async()=>{
        const controller=new AbortController(),remove=vi.spyOn(controller.signal,'removeEventListener');
        const result=chatFileBase64(file,controller.signal),reader=BrowserReader.instances[0];expect(reader.readAsDataURL).toHaveBeenCalledWith(file);
        reader.result='data:text/markdown;base64,0J/RgNC40LLQtdGC';reader.onload!();
        expect(await result).toBe('0J/RgNC40LLQtdGC');expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));
        controller.abort();expect(reader.abort).not.toHaveBeenCalled();
    });
    it.each([null,new ArrayBuffer(3),'not-a-data-url'])('Ошибочный результат %j не превращается в пустую успешную загрузку',async(value)=>{
        const controller=new AbortController(),remove=vi.spyOn(controller.signal,'removeEventListener');
        const result=chatFileBase64(file,controller.signal),rejected=expect(result).rejects.toThrow('Не удалось прочитать файл.');
        const reader=BrowserReader.instances[0];reader.result=value;reader.onload!();await rejected;expect(remove).toHaveBeenCalledOnce();
        controller.abort();expect(reader.abort).not.toHaveBeenCalled();
    });
    it('Ошибка устройства чтения очищает listener и объясняет повторный выбор',async()=>{
        const controller=new AbortController(),remove=vi.spyOn(controller.signal,'removeEventListener');
        const result=chatFileBase64(file,controller.signal),rejected=expect(result).rejects.toThrow('Выберите его снова');BrowserReader.instances[0].onerror!();await rejected;
        expect(remove).toHaveBeenCalledOnce();controller.abort();expect(BrowserReader.instances[0].abort).not.toHaveBeenCalled();
    });
    it('Уже отменённая загрузка не начинает чтение даже если EMPTY reader не посылает onabort',async()=>{
        const controller=new AbortController();controller.abort();BrowserReader.emitAbort=false;
        const result=chatFileBase64(file,controller.signal);expect(BrowserReader.instances[0].readAsDataURL).not.toHaveBeenCalled();expect(BrowserReader.instances[0].abort).toHaveBeenCalledOnce();
        await expect(result).rejects.toMatchObject({name:'AbortError'});
    });
    it('Отмена активного чтения останавливает reader, а поздний load не меняет отказ',async()=>{
        const controller=new AbortController(),result=chatFileBase64(file,controller.signal),rejected=expect(result).rejects.toMatchObject({name:'AbortError'});
        const reader=BrowserReader.instances[0];controller.abort();await rejected;expect(reader.abort).toHaveBeenCalledOnce();reader.result='data:text/plain;base64,late';reader.onload!();await expect(result).rejects.toMatchObject({name:'AbortError'});
    });
    it('Внешняя отмена самого FileReader также снимает listener',async()=>{
        const controller=new AbortController(),remove=vi.spyOn(controller.signal,'removeEventListener');
        const result=chatFileBase64(file,controller.signal),rejected=expect(result).rejects.toMatchObject({name:'AbortError'});BrowserReader.instances[0].onabort!();await rejected;expect(remove).toHaveBeenCalledOnce();
        controller.abort();expect(BrowserReader.instances[0].abort).not.toHaveBeenCalled();
    });
});

describe('Границы файлов и представление размера',()=>{
    it('Не допускает пустое имя/содержимое и превышение точной границы, сохраняет регистр исходного имени',()=>{
        expect(chatFileError({name:'',size:1})).toContain('Пустой');expect(chatFileError({name:'a.md',size:0})).toContain('Пустой');
        expect(chatFileError({name:'Report.PDF',size:CHAT_FILE_MAX_BYTES})).toBe('');expect(chatFileError({name:'Report.PDF',size:CHAT_FILE_MAX_BYTES+1})).toContain('10 МиБ');
        expect(chatFileError({name:'source',size:1})).toContain('OCR');for(const name of ['Dockerfile','Makefile','.gitignore','.editorconfig'])expect(chatFileError({name,size:1})).toBe('');
    });
    it('Честно форматирует байты и пограничные КиБ/МиБ',()=>{
        expect([0,1023,1024,1025,1048575,1048576,1572864].map(chatFileSize)).toEqual(['0 Б','1023 Б','1 КиБ','2 КиБ','1024 КиБ','1.0 МиБ','1.5 МиБ']);
    });
});
