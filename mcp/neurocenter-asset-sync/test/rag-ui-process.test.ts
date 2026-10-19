import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {spawn} from 'node:child_process';
import {startRagUiProcess} from '../src/features/rag-ui/process.js';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
const url='http://127.0.0.1:49152/#neurocenter-token='+'a'.repeat(48);
const ready={type:'neurocenter-rag-ui-ready',url,port:49152};
class Child extends EventEmitter{
    pid=12345;connected=true;stdout=new PassThrough();stderr=new PassThrough();
    disconnect=vi.fn(()=>{this.connected=false;this.emit('close',0);});kill=vi.fn();
}
describe('Локальный UI принадлежит мосту и подтверждает готовность только по IPC',()=>{
    let child:Child;
    beforeEach(()=>{vi.useFakeTimers();child=new Child();vi.mocked(spawn).mockReturnValue(child as never);vi.spyOn(process,'kill').mockReturnValue(true);});
    afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
    it('Запускает только Node entrypoint без shell и закрывает сервер по disconnect',async()=>{
        const pending=startRagUiProcess('/managed/opencode-rag.mjs',['ui','--port','0','--no-open'],'/owned/project',{});
        child.emit('message',ready);const session=await pending;
        expect(spawn).toHaveBeenCalledWith(process.execPath,['/managed/opencode-rag.mjs','ui','--port','0','--no-open'],expect.objectContaining({shell:false,stdio:['ignore','pipe','pipe','ipc']}));
        expect(session.url).toBe(url);await session.stop();expect(child.disconnect).toHaveBeenCalledOnce();expect(process.kill).not.toHaveBeenCalled();
    });
    it('Таймаут готовности закрывает только собственный процесс; поздний IPC не превращается в успех',async()=>{
        const pending=startRagUiProcess('/managed/opencode-rag.mjs',['ui'],'/owned/project',{}).catch(error=>error);
        await vi.advanceTimersByTimeAsync(20001);const error=await pending;
        expect(error).toBeInstanceOf(Error);expect(error.message).toContain('отведённое время');expect(child.disconnect).toHaveBeenCalledOnce();
        child.emit('message',ready);expect(child.listenerCount('message')).toBe(0);
    });
    it.each([{...ready,url:url.replace('127.0.0.1','evil.test')},{...ready,port:123},{...ready,secret:'private'}])('Небезопасный IPC не раскрывает URL и завершает дочерний сервер',async value=>{
        const pending=startRagUiProcess('/managed/opencode-rag.mjs',['ui'],'/owned/project',{}).catch(error=>error);
        child.emit('message',value);const error=await pending;
        expect(error.message).not.toContain(url);expect(error.message).not.toContain('private');expect(child.disconnect).toHaveBeenCalledOnce();
    });
    it('Раннее завершение не становится успешным открытием окна',async()=>{
        const pending=startRagUiProcess('/managed/opencode-rag.mjs',['ui'],'/owned/project',{}).catch(error=>error);
        child.emit('close',1);child.emit('exit',1);expect((await pending).message).toContain('до готовности');
    });
    it('Зависший после disconnect процесс получает ограниченное завершение своей группы',async()=>{
        child.disconnect.mockImplementation(()=>{child.connected=false;});
        const pending=startRagUiProcess('/managed/opencode-rag.mjs',['ui'],'/owned/project',{});child.emit('message',ready);const session=await pending;
        const stopped=session.stop();await vi.advanceTimersByTimeAsync(1201);await stopped;
        if(process.platform==='win32')expect(child.kill).toHaveBeenCalledWith('SIGKILL');else expect(process.kill).toHaveBeenCalledWith(-12345,'SIGKILL');
    });
    it('Восстановление не прерывает занятый UI после graceful deadline',async()=>{
        child.disconnect.mockImplementation(()=>{child.connected=false;});
        const pending=startRagUiProcess('/managed/opencode-rag.mjs',['ui'],'/owned/project',{});child.emit('message',ready);const session=await pending;
        const stopped=session.stop({force:false}).catch(error=>error);await vi.advanceTimersByTimeAsync(1201);
        expect((await stopped).message).toContain('Дождитесь');expect(process.kill).not.toHaveBeenCalled();expect(child.kill).not.toHaveBeenCalled();
    });
});
