import {uuid} from './model';
export interface GgufJournal {read:()=>string|null;write:(requestKey:string,expected:string|null)=>void;clear:(expected:string)=>void;}

/** Only the request UUID is durable; file bytes, file metadata and provider keys are never stored. */
export function ggufJournal(storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,owner:string):GgufJournal{
    const key='neurocenter:gguf-import:v1:'+encodeURIComponent(owner);
    const read=()=>{
        if(!owner)throw Error('Владелец импорта не подтверждён. Обновите сеанс.');
        const raw=storage.getItem(key);if(raw===null)return null;
        let value:unknown;try{if(raw.length>200)throw Error();value=JSON.parse(raw);}catch{throw Error('Сохранённый номер импорта повреждён. Исходные данные сохранены; новый импорт приостановлен.');}
        if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='requestKey,version'
            ||(value as {version:unknown}).version!==1||!uuid((value as {requestKey:unknown}).requestKey))throw Error('Сохранённый номер импорта не подтверждён. Исходные данные сохранены; новый импорт приостановлен.');
        return (value as {requestKey:string}).requestKey;
    };
    return {read,write:(requestKey,expected)=>{if(!uuid(requestKey)||read()!==expected)throw Error('Импорт изменился в другой вкладке. Обновите его состояние.');storage.setItem(key,JSON.stringify({version:1,requestKey}));},
        clear:expected=>{if(read()!==expected)throw Error('Импорт изменился в другой вкладке. Обновите его состояние.');storage.removeItem(key);}};
}
