import type {IRagQuota} from '../../../../core/api/interfaces';
export const MEBIBYTE=1024**2;

/** Счётчик и поле ввода используют одинаковые двоичные единицы. */
export function formatRagBytes(bytes:number):string{
    const power=bytes<1024?0:bytes<1024**2?1:bytes<1024**3?2:3;
    return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(bytes/1024**power)+' '+['Б','КиБ','МиБ','ГиБ'][power];
}

/** Недоступный или повреждённый счётчик не превращается в свободное место. */
export function requireRagQuota(value:unknown):IRagQuota{
    const input=value as IRagQuota|null;
    if(!input||!['usedBytes','limitBytes','revision','maximumBytes','availableBytes'].every(key=>Number.isSafeInteger(input[key as keyof IRagQuota])&&input[key as keyof IRagQuota]>=0)
        ||input.limitBytes<=0||input.maximumBytes<=0||input.usedBytes>input.limitBytes||input.availableBytes!==input.limitBytes-input.usedBytes){throw new Error('Сервер вернул некорректные сведения о лимите. Обновите данные.');}
    return input;
}

export function ragLimitBytes(value:unknown,maximum:number):number{
    if(typeof value!=='number'||!Number.isFinite(value)||value<=0){throw new Error('Укажите положительный лимит.');}
    const bytes=Math.round(value*MEBIBYTE);if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>maximum){throw new Error('Лимит превышает разрешённый максимум сервера.');}return bytes;
}

export const ragQuotaPercent=(quota:IRagQuota):number=>Math.min(100,Math.floor(quota.usedBytes/quota.limitBytes*100));
