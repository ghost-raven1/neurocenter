import { promises as fs } from 'fs';
import path from 'path';

const MAX_ENTRIES=10_000;
const MAX_DEPTH=32;
const TIMEOUT_MS=1_000;
interface IWalk { entries:number; stopped:boolean; deadline:number }

function checkBudget(walk:IWalk):void {
    if(walk.stopped||Date.now()>=walk.deadline){throw new Error('Измерение не завершено вовремя.');}
}

/** Таймаут ограничивает ответ; уже начатый системный I/O завершается без продолжения обхода. */
async function boundedMeasurement(action:(walk:IWalk)=>Promise<number>):Promise<number|null> {
    const walk:IWalk={entries:0,stopped:false,deadline:Date.now()+TIMEOUT_MS};
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<null>(resolve=>{timer=setTimeout(()=>{walk.stopped=true;resolve(null);},TIMEOUT_MS);});
    try {return await Promise.race([action(walk).catch(()=>null),timeout]);}
    finally {if(timer){clearTimeout(timer);}}
}

async function walkDirectory(dir:string,depth:number,walk:IWalk):Promise<number> {
    checkBudget(walk);
    if(depth>MAX_DEPTH){throw new Error('Слишком глубокий каталог.');}
    const before=await fs.lstat(dir);
    checkBudget(walk);
    if(!before.isDirectory()||before.isSymbolicLink()){throw new Error('Каталог данных недоступен.');}
    const directory=await fs.opendir(dir);
    if(walk.stopped){await directory.close();throw new Error('Измерение остановлено.');}
    let total = 0;
    for await(const entry of directory) {
        checkBudget(walk);
        if(++walk.entries>MAX_ENTRIES){throw new Error('Слишком много элементов каталога.');}
        const p=path.join(dir,entry.name);
        const stat=await fs.lstat(p);
        checkBudget(walk);
        if(stat.isSymbolicLink()){continue;}
        if (stat.isDirectory()) {
            total += await walkDirectory(p,depth+1,walk);
        } else if (stat.isFile()) {
            total += stat.size;
        }
        if(!Number.isSafeInteger(total)){throw new Error('Размер не помещается в точное число.');}
    }
    const after=await fs.lstat(dir);
    checkBudget(walk);
    if(!after.isDirectory()||after.dev!==before.dev||after.ino!==before.ino){throw new Error('Каталог изменился во время измерения.');}
    return total;
}

/** Сумма файлов без перехода по ссылкам; ошибка или превышенный бюджет дают неизвестный размер. */
export function measureDirectorySize(dir:string):Promise<number|null> {
    return boundedMeasurement(walk=>walkDirectory(dir,0,walk));
}

/** Размер серверного .opencode; отсутствие настроенной папки не считается пустыми данными. */
export async function measureProjectDataSize(fsRootPath: string | null | undefined): Promise<number|null> {
    const root = (fsRootPath ?? '').trim();
    if(!root){return null;}
    return boundedMeasurement(async walk=>{
        const canonical=await fs.realpath(root);checkBudget(walk);
        const before=await fs.lstat(canonical);checkBudget(walk);
        if(!before.isDirectory()){throw new Error('Папка проекта недоступна.');}
        const data=path.join(canonical,'.opencode');
        try {await fs.lstat(data);}
        catch(error) {
            if((error as NodeJS.ErrnoException).code!=='ENOENT'){throw error;}
            const after=await fs.lstat(canonical);checkBudget(walk);
            if(after.dev!==before.dev||after.ino!==before.ino){throw new Error('Папка проекта изменилась.');}
            return 0;
        }
        checkBudget(walk);
        return walkDirectory(data,0,walk);
    });
}
