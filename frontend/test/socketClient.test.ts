import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Manager} from 'socket.io-client';
import {SocketClient} from '../src/core/socket/socketClient';

const factory=vi.hoisted(()=>vi.fn());
vi.mock('socket.io-client',async original=>({...await original<typeof import('socket.io-client')>(),io:factory}));

/** Настоящий Socket/Manager с заглушкой транспорта: соединений и HTTP-запросов нет. */
function rawFixture() {
    const manager=new Manager('http://127.0.0.1:1',{autoConnect:false,reconnection:true});
    const open=vi.spyOn(manager,'open').mockReturnValue(manager);
    vi.spyOn(manager as unknown as {_packet():void},'_packet').mockImplementation(()=>{});
    const raw=manager.socket('/');
    const connect=vi.spyOn(raw,'connect');
    const namespace=raw as unknown as {
        onconnect(id:string):void;
        ondisconnect():void;
        onpacket(packet:{nsp:string;type:number;data:{message:string}}):void;
        onclose(reason:string):void;
        onerror(error:Error):void;
        onevent(packet:{data:unknown[]}):void;
    };
    return {raw,open,connect,
        connected:()=>namespace.onconnect('fixture-connection'),
        serverDisconnect:()=>namespace.ondisconnect(),
        rejected:()=>namespace.onpacket({nsp:'/',type:4,data:{message:'Проверка входа временно недоступна'}}),
        transportClosed:()=>namespace.onclose('transport close'),
        transportError:()=>namespace.onerror(new Error('transport failure')),
        receive:(event:string,payload:unknown)=>namespace.onevent({data:[event,payload]}),
    };
}
let created:Array<ReturnType<typeof rawFixture>>;
let client:SocketClient;
beforeEach(()=>{
    vi.useFakeTimers();created=[];client=new SocketClient();factory.mockReset();
    factory.mockImplementation(()=>{const value=rawFixture();created.push(value);value.raw.connect();return value.raw;});
});
afterEach(()=>{client.disconnect();created.forEach(value=>value.raw.disconnect());vi.restoreAllMocks();vi.useRealTimers();});

const current=()=>created[created.length-1];

describe('Восстановление канала событий без смены пользователя и потери подписок',()=>{
    it('Повторный connect активного namespace сохраняет один raw и его подписки',()=>{
        const refresh=vi.fn();client.connect();client.on('section:changed',refresh);client.connect();client.connect();
        expect(factory).toHaveBeenCalledOnce();expect(current().connect).toHaveBeenCalledOnce();
        expect(current().raw.listeners('section:changed')).toEqual([refresh]);expect(vi.getTimerCount()).toBe(0);
    });
    it('Отписка снимает только свой обработчик; новый сеанс создаёт отдельное соединение',()=>{
        const refresh=vi.fn();client.connect();client.on('connect',refresh);client.off('connect',refresh);
        expect(current().raw.listeners('connect')).not.toContain(refresh);
        client.disconnect();client.connect();expect(factory).toHaveBeenCalledTimes(2);expect(created[0].raw.active).toBe(false);
    });
    it.each(['server-disconnect','connect-error'] as const)('После %s один отложенный retry оживляет тот же namespace и сохраняет пользовательские callbacks',kind=>{
        const refresh=vi.fn();client.connect();client.on('section:changed',refresh);const original=current();
        if(kind==='server-disconnect'){original.connected();original.serverDisconnect();}else original.rejected();
        expect(original.raw.active).toBe(false);expect(vi.getTimerCount()).toBe(1);
        original.rejected();expect(vi.getTimerCount()).toBe(1);vi.advanceTimersByTime(4999);expect(original.connect).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(1);expect(original.connect).toHaveBeenCalledTimes(2);expect(original.raw.active).toBe(true);expect(factory).toHaveBeenCalledOnce();
        original.connected();original.receive('section:changed',{sections:['catalog'],at:'fixture'});
        expect(refresh).toHaveBeenCalledOnce();expect(original.raw.listeners('section:changed')).toEqual([refresh]);expect(vi.getTimerCount()).toBe(0);
    });
    it('Повторный отказ handshake планирует ровно одну следующую попытку, успех отменяет ожидание',()=>{
        client.connect();const raw=current();raw.rejected();vi.advanceTimersByTime(5000);raw.rejected();raw.rejected();
        expect(vi.getTimerCount()).toBe(1);expect(raw.connect).toHaveBeenCalledTimes(2);
        raw.connected();expect(vi.getTimerCount()).toBe(0);vi.advanceTimersByTime(30000);expect(raw.connect).toHaveBeenCalledTimes(2);
    });
    it('Потеря транспорта с active=true остаётся штатному reconnection без второй попытки обёртки',()=>{
        client.connect();const raw=current();raw.connected();raw.transportClosed();raw.transportError();
        expect(raw.raw.active).toBe(true);expect(vi.getTimerCount()).toBe(0);client.connect();expect(raw.connect).toHaveBeenCalledOnce();
    });
    it('Явный connect немедленно оживляет существующий inactive raw и отменяет отложенный retry',()=>{
        client.connect();const raw=current();raw.connected();raw.serverDisconnect();expect(vi.getTimerCount()).toBe(1);
        client.connect();expect(raw.connect).toHaveBeenCalledTimes(2);expect(raw.raw.active).toBe(true);expect(factory).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);vi.advanceTimersByTime(30000);expect(raw.connect).toHaveBeenCalledTimes(2);
    });
    it('Выход останавливает таймер и поздние callbacks старого raw не создают соединений',()=>{
        client.connect();const raw=current();raw.rejected();expect(vi.getTimerCount()).toBe(1);
        client.disconnect();expect(vi.getTimerCount()).toBe(0);raw.rejected();raw.connected();raw.serverDisconnect();
        vi.advanceTimersByTime(30000);expect(factory).toHaveBeenCalledOnce();expect(raw.connect).toHaveBeenCalledOnce();
    });
    it('Уже сохранённый callback старого таймера не снимает защиту новой сессии',()=>{
        const timers=vi.spyOn(globalThis,'setTimeout');client.connect();const old=current();old.rejected();
        const oldTimer=timers.mock.calls.find(([,delay])=>delay===5000)?.[0];expect(oldTimer).toBeTypeOf('function');
        client.disconnect();client.connect();const fresh=current();fresh.rejected();expect(vi.getTimerCount()).toBe(1);
        (oldTimer as ()=>void)();old.connected();old.rejected();fresh.rejected();
        expect(vi.getTimerCount()).toBe(1);vi.advanceTimersByTime(5000);
        expect(old.connect).toHaveBeenCalledOnce();expect(fresh.connect).toHaveBeenCalledTimes(2);expect(factory).toHaveBeenCalledTimes(2);
    });
});
