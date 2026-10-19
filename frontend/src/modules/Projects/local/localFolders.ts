export interface ILocalFile {
    kind: 'file'; name: string;
    getFile(): Promise<File>;
    createWritable(): Promise<{write(data:string):Promise<void>;close():Promise<void>;abort():Promise<void>}>;
}
export interface ILocalDirectory {
    kind: 'directory'; name: string;
    values(): AsyncIterable<ILocalDirectory | ILocalFile>;
    getDirectoryHandle(name:string,options?:{create?:boolean}):Promise<ILocalDirectory>;
    getFileHandle(name:string,options?:{create?:boolean}):Promise<ILocalFile>;
    queryPermission(options:{mode:'readwrite'}):Promise<PermissionState>;
    requestPermission(options:{mode:'readwrite'}):Promise<PermissionState>;
    resolve?(directory:ILocalDirectory):Promise<string[]|null>;
}
export interface ILocalBinding { projectId:string; server:string; folderName:string; handle:ILocalDirectory; }
interface IStoredWorkspace { root?:ILocalDirectory; bindings:ILocalBinding[]; }
type TPicker = (options:{id:string;mode:'readwrite';startIn?:ILocalDirectory})=>Promise<ILocalDirectory>;

/** Выбор и содержимое папок остаются на устройстве; сервер получает только ID проекта в обычных API. */
export const canChooseLocalFolder = ():boolean => typeof (window as Window & {showDirectoryPicker?:TPicker}).showDirectoryPicker === 'function';

export async function chooseDirectory(root?:ILocalDirectory):Promise<ILocalDirectory> {
    const picker = (window as Window & {showDirectoryPicker?:TPicker}).showDirectoryPicker;
    if (!picker) { throw new Error('Выбор локальной папки доступен в настольных Chrome, Edge и других браузерах с File System Access. Откройте эту страницу в поддерживаемом браузере.'); }
    return picker({id:root?'neurocenter-project':'neurocenter-projects',mode:'readwrite',...(root?{startIn:root}:{})});
}

function workspace<T>(email:string,action:(store:IDBObjectStore)=>IDBRequest<T>,write=false):Promise<T> {
    return new Promise((resolve,reject)=>{
        const opening = indexedDB.open('neurocenter-local-projects',1);
        opening.onupgradeneeded=()=>opening.result.createObjectStore('workspaces');
        opening.onerror=()=>reject(new Error('Не удалось открыть локальное хранилище браузера. Разрешите хранение данных для этой страницы.'));
        opening.onblocked=()=>reject(new Error('Закройте другие вкладки Нейроцентра и повторите выбор папки.'));
        opening.onsuccess=()=>{
            const db=opening.result;
            const transaction=db.transaction('workspaces',write?'readwrite':'readonly');
            let request:IDBRequest<T>;
            try {request=action(transaction.objectStore('workspaces'));}
            catch {db.close();reject(new Error('Браузер не смог сохранить доступ к папке. Проверьте разрешение хранения данных.'));return;}
            let result:T;
            request.onsuccess=()=>{result=request.result;};
            transaction.oncomplete=()=>{db.close();resolve(result);};
            transaction.onabort=transaction.onerror=()=>{db.close();reject(new Error(`Не удалось сохранить привязку папки для ${email}. Проверьте настройки хранения браузера.`));};
        };
    });
}

export async function loadWorkspace(email:string):Promise<IStoredWorkspace> {
    return await workspace<IStoredWorkspace|undefined>(email,store=>store.get(email)) ?? {bindings:[]};
}
export async function saveWorkspace(email:string,value:IStoredWorkspace):Promise<void> {
    await workspace(email,store=>{
        const request:IDBRequest<IStoredWorkspace|undefined>=store.get(email);
        request.addEventListener('success',()=>{
            const previous=request.result?.bindings ?? [];
            const bindings=new Map([...previous,...value.bindings].map(item=>[`${item.server}/${item.projectId}`,item]));
            store.put({...value,bindings:[...bindings.values()]},email);
        });
        return request;
    },true);
}

export async function childDirectories(root:ILocalDirectory):Promise<ILocalDirectory[]> {
    if (await root.queryPermission({mode:'readwrite'})!=='granted') { throw new Error('Доступ к папке нужно подтвердить заново. Нажмите «Открыть доступ к папке».'); }
    const children:ILocalDirectory[]=[];
    for await (const entry of root.values()) {
        if (entry.kind==='directory' && !entry.name.startsWith('.')) { children.push(entry); }
        if (children.length>500) { throw new Error('В папке больше 500 проектов. Выберите более узкую папку.'); }
    }
    return children.sort((left,right)=>left.name.localeCompare(right.name,'ru'));
}

/** Каноническая привязка не зависит от названий проекта и локальной папки. Чужую привязку не заменяем. */
export async function bindDirectory(handle:ILocalDirectory,projectId:string,server:string):Promise<ILocalBinding> {
    if (!projectId || new URL(server).origin!==server) { throw new Error('Не удалось определить сервер и проект для привязки.'); }
    const permission=await handle.queryPermission({mode:'readwrite'});
    if (permission!=='granted' && await handle.requestPermission({mode:'readwrite'})!=='granted') { throw new Error('Нет разрешения записать привязку в выбранную папку.'); }
    let existing:string|undefined;
    try {
        const directory=await handle.getDirectoryHandle('.opencode');
        existing=await (await (await directory.getFileHandle('neurocenter.json')).getFile()).text();
    } catch(error) { if ((error as DOMException).name!=='NotFoundError') { throw error; } }
    if (existing!==undefined) {
        let previous:{version?:unknown;projectId?:unknown;server?:unknown};
        try { previous=JSON.parse(existing); if(!previous || typeof previous!=='object'){throw new Error();} }
        catch { throw new Error('В папке уже есть нечитаемый .opencode/neurocenter.json. Привязка не изменена.'); }
        if (previous.version!==1 || previous.projectId!==projectId || previous.server!==server) { throw new Error('Папка уже привязана к другому проекту или серверу. Выберите другую папку.'); }
    } else {
        const directory=await handle.getDirectoryHandle('.opencode',{create:true});
        const file=await directory.getFileHandle('neurocenter.json',{create:true});
        const writer=await file.createWritable();
        try { await writer.write(JSON.stringify({version:1,server,projectId},null,2)+'\n'); await writer.close(); }
        catch(error) { await writer.abort().catch(()=>undefined); throw error; }
    }
    return {projectId,server,folderName:handle.name,handle};
}

export const isPickerCancelled = (error:unknown):boolean => (error as DOMException)?.name==='AbortError';
