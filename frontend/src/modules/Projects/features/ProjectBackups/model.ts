export interface IProjectBackup {id:string;projectId:string;fileName:string;sizeBytes:number;createdAt:string;warnings?:string[];}

/** Успех подтверждается полным файлом выбранного проекта, а не только HTTP 200. */
export function requireProjectBackup(value:unknown,projectId:string):IProjectBackup {
    const item=value as IProjectBackup|null;
    if(!item||typeof item.id!=='string'||!item.id||item.projectId!==projectId||typeof item.fileName!=='string'||!item.fileName.endsWith('.dump')||/[\\/\x00]/.test(item.fileName)
        ||!Number.isSafeInteger(item.sizeBytes)||item.sizeBytes<=0||typeof item.createdAt!=='string'||!Number.isFinite(Date.parse(item.createdAt))
        ||item.warnings!==undefined&&(!Array.isArray(item.warnings)||item.warnings.some(text=>typeof text!=='string'))){throw new Error('Сервер не подтвердил копию выбранного проекта. Обновите список перед повтором.');}
    return item;
}
