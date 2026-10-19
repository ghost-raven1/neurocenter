import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {dispatchBrowserWindow} from '../src/features/rag-ui/browser-window.js';
vi.mock('node:child_process',()=>({spawn:vi.fn(),execFile:vi.fn()}));
describe('Отдельное окно не завершается вместе с первым процессом браузера',()=>{
    let child:EventEmitter&{unref:ReturnType<typeof vi.fn>;kill:ReturnType<typeof vi.fn>};
    beforeEach(()=>{vi.useFakeTimers();child=Object.assign(new EventEmitter(),{unref:vi.fn(),kill:vi.fn()});vi.mocked(spawn).mockReturnValue(child as never);});
    afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
    it('Долгоживущий первый browser instance принимается после startup и не получает timeout kill',async()=>{
        const pending=dispatchBrowserWindow({file:'/usr/bin/firefox',args:['-new-window','http://127.0.0.1:1234/']});child.emit('spawn');
        await vi.advanceTimersByTimeAsync(351);await pending;await vi.advanceTimersByTimeAsync(10000);
        expect(child.unref).toHaveBeenCalledOnce();expect(child.kill).not.toHaveBeenCalled();
        expect(spawn).toHaveBeenCalledWith('/usr/bin/firefox',expect.any(Array),expect.objectContaining({shell:false,detached:true,stdio:'ignore'}));
    });
    it('Уже открытый браузер может немедленно подтвердить передачу окна нулевым exit',async()=>{
        const pending=dispatchBrowserWindow({file:'browser.exe',args:['--new-window','http://127.0.0.1:1234/']});child.emit('spawn');child.emit('exit',0);await pending;
        expect(child.unref).toHaveBeenCalledOnce();expect(child.kill).not.toHaveBeenCalled();
    });
    it('Ранний отказ остаётся ошибкой запуска без URL в тексте',async()=>{
        const pending=dispatchBrowserWindow({file:'browser.exe',args:['--new-window','http://127.0.0.1:1234/#private']}).catch(error=>error);
        child.emit('error',new Error('URL private'));expect((await pending).message).not.toContain('private');expect(child.kill).not.toHaveBeenCalled();
    });
});
