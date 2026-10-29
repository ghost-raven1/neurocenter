import {sha, uuid} from './model';

export interface TextUploadIntent {version:1; projectId:string; email:string; requestKey:string; expectedRevision:number; requestHash:string;}
export interface TextJournal {read:() => TextUploadIntent | null; write:(intent:TextUploadIntent, expectedRequestKey?:string) => void;}

/** Only receipt identity is durable: file paths and contents stay in memory. */
export function textUploadJournal(storage:Pick<Storage,'getItem'|'setItem'>, projectId:string, email:string, journalOwner:string):TextJournal {
    const key = `neurocenter:text-upload:v1:${encodeURIComponent(journalOwner)}:${encodeURIComponent(projectId)}`;
    const read = ():TextUploadIntent | null => {
            if(!journalOwner)throw Error('Владелец журнала загрузки не подтверждён. Новая загрузка приостановлена.');
            const raw = storage.getItem(key);
            if (raw === null) return null;
            let value:TextUploadIntent;
            try { value = JSON.parse(raw) as TextUploadIntent; }
            catch { throw Error('Журнал загрузки повреждён. Данные сохранены; новая загрузка приостановлена.'); }
            if (!value || Object.keys(value).sort().join(',') !== 'email,expectedRevision,projectId,requestHash,requestKey,version'
                || value.version !== 1 || value.projectId !== projectId || value.email !== email || !uuid(value.requestKey)
                || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || !sha(value.requestHash)) {
                throw Error('Журнал загрузки не подтверждён. Данные сохранены; новая загрузка приостановлена.');
            }
            return value;
    };
    return {read,
        write:(intent, expectedRequestKey) => {
            const previous = read();
            if (previous?.requestKey !== expectedRequestKey) throw Error('Журнал изменился в другой вкладке. Обновите страницу и проверьте прежнюю загрузку.');
            storage.setItem(key, JSON.stringify(intent));
        },
    };
}

export async function uploadHash(canonical:string):Promise<string> {
    if (!globalThis.crypto?.subtle) throw Error('Для безопасного повтора загрузки откройте площадку по HTTPS или localhost.');
    const bytes = new TextEncoder().encode(canonical);
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2,'0')).join('');
}
