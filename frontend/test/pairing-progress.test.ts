import {afterEach,describe,expect,it,vi} from 'vitest';
import {waitForComputer} from '../src/features/McpBridge/pairingProgress';
import type {IBridgeDevice} from '../src/features/McpBridge/api';

const device=(id:string,online:boolean):IBridgeDevice=>({id,name:'Проверочный компьютер',fingerprint:id,role:'Разработчик',online,lastSeen:null,report:{}});
afterEach(()=>vi.useRealTimers());
describe('Подтверждение подключения до выбора папки',()=>{
    it('Ждёт online-отчёт своего отпечатка и не принимает другой компьютер',async()=>{
        vi.useFakeTimers();const read=vi.fn().mockResolvedValueOnce([device('other',true),device('mine',false)]).mockResolvedValue([device('mine',true)]);
        const pending=waitForComputer('mine',read,new AbortController().signal);
        await vi.advanceTimersByTimeAsync(1000);expect((await pending).id).toBe('mine');expect(read).toHaveBeenCalledTimes(2);
    });
    it('Временный обрыв чтения не подменяет успешное подключение ошибкой',async()=>{
        vi.useFakeTimers();const read=vi.fn().mockRejectedValueOnce(new Error('Обрыв')).mockResolvedValue([device('mine',true)]);
        const pending=waitForComputer('mine',read,new AbortController().signal);
        await vi.advanceTimersByTimeAsync(1000);expect((await pending).online).toBe(true);
    });
    it('Ограничивает ожидание и предлагает повторить проверку вместо повторной установки',async()=>{
        vi.useFakeTimers();const pending=waitForComputer('mine',async()=>[],new AbortController().signal,2000);
        const assertion=expect(pending).rejects.toThrow('Проверить снова');await vi.advanceTimersByTimeAsync(2000);await assertion;
    });
    it('Закрытие окна останавливает опрос и освобождает таймер',async()=>{
        vi.useFakeTimers();const controller=new AbortController();const read=vi.fn().mockResolvedValue([]);
        const pending=waitForComputer('mine',read,controller.signal);const assertion=expect(pending).rejects.toMatchObject({name:'AbortError'});
        await vi.advanceTimersByTimeAsync(0);controller.abort();await assertion;expect(vi.getTimerCount()).toBe(0);expect(read).toHaveBeenCalledTimes(1);
    });
    it('Не выдаёт успех после отмены запроса, даже если ответ компьютера уже пришёл',async()=>{
        const controller=new AbortController();const read=vi.fn(async()=>{controller.abort();return [device('mine',true)];});
        await expect(waitForComputer('mine',read,controller.signal)).rejects.toMatchObject({name:'AbortError'});
    });
});
