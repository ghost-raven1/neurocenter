import type {IBridgeDevice} from './api';

export const CONNECTED_DEVICE_EVENT='neurocenter:connected-device';

/** Все открытые блоки выбирают именно подтверждённый компьютер, а не прежнее устройство. */
export function selectConnectedComputer(email:string,id:string):void {
    try{localStorage.setItem('neurocenter.device.'+email,id);}catch{/* Приватный режим браузера. */}
    window.dispatchEvent(new CustomEvent(CONNECTED_DEVICE_EVENT,{detail:id}));
}

const cancelled=():DOMException=>new DOMException('Проверка подключения отменена.','AbortError');
function pause(signal:AbortSignal):Promise<void>{
    return new Promise((resolve,reject)=>{
        if(signal.aborted){reject(cancelled());return;}
        const abort=():void=>{clearTimeout(timer);reject(cancelled());};
        const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},1000);
        signal.addEventListener('abort',abort,{once:true});
    });
}

/** Подтверждение завершается только после появления online-отчёта этого отпечатка. */
export async function waitForComputer(fingerprint:string,read:(signal?:AbortSignal)=>Promise<IBridgeDevice[]>,signal:AbortSignal,timeoutMs=30000):Promise<IBridgeDevice>{
    const until=Date.now()+timeoutMs;
    while(Date.now()<until){
        if(signal.aborted){throw cancelled();}
        try{
            const devices=await read(signal);
            if(signal.aborted){throw cancelled();}
            const connected=devices.find(device=>device.fingerprint===fingerprint&&device.online);
            if(connected){return connected;}
        }catch{if(signal.aborted){throw cancelled();}}
        await pause(signal);
    }
    throw new Error('Компьютер ещё не ответил. Оставьте его включённым и проверьте соединение. Затем нажмите «Проверить снова».');
}
