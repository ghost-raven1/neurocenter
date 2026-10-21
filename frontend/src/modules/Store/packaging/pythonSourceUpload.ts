import {packagingEntrypoints,type PackagingFilesResult} from './sourceFiles';
import type {PackagingFile} from './types';

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const jsEntry=(value:unknown):boolean=>typeof value==='string'?/\.(?:[cm]?[jt]s|tsx)$/.test(value)&&!/\.d\.[cm]?ts$/.test(value):object(value)&&Object.values(value).some(jsEntry);
function explicitJavaScript(files:PackagingFile[]):boolean{
    try{
        const metadata:unknown=JSON.parse(files.find(file=>file.path==='package.json')?.content??'{}');
        return object(metadata)&&(jsEntry(metadata.bin)||jsEntry(metadata.main)||jsEntry(metadata.module)||jsEntry(metadata.exports)
            ||object(metadata.dependencies)&&Object.prototype.hasOwnProperty.call(metadata.dependencies,'@opencode-ai/plugin'));
    }catch{return false;}
}

/** Python projects use server inspection; skills and explicitly declared JS tools retain their existing flow. */
export function isPythonSourceUpload(source:PackagingFilesResult):boolean{
    const files=source.files;
    if(files.some(file=>/(?:^|\/)SKILL\.md$/.test(file.path))||explicitJavaScript(files))return false;
    const python=files.filter(file=>file.path.endsWith('.py'));
    if(!python.length)return false;
    const directories=[...new Set(files.filter(file=>/(?:^|\/)(?:pyproject\.toml|requirements\.txt)$/.test(file.path))
        .map(file=>file.path.slice(0,file.path.lastIndexOf('/')+1)))];
    if(directories.includes('')||directories.length===1&&python.some(file=>file.path.startsWith(directories[0])))return true;
    return packagingEntrypoints(files,'mcp').length===0;
}

const encoder=new TextEncoder();
const forbidden=/(?:^|\/)(?:\.git|node_modules|\.npmrc|\.yarnrc(?:\.yml)?|\.env(?:\.[^/]*)?|id_rsa(?:\.[^/]*)?|id_ed25519(?:\.[^/]*)?)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i;
function checkedPath(value:string):string{
    if(!value||value!==value.trim()||encoder.encode(value).length>240||value.startsWith('/')||/[\\\x00-\x1f\x7f<>:"|?*]/.test(value)
        ||value.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))||forbidden.test(value))throw new Error('Недопустимый или секретный путь исходников Python.');
    return value;
}
function bytes(file:PackagingFile):Uint8Array<ArrayBuffer>{
    if(typeof file.content!=='string')throw new Error('Исходники Python должны содержать проверенные файлы.');
    if(file.encoding===undefined){
        const result=encoder.encode(file.content);
        if(file.content.includes('\0')||new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(result)!==file.content)throw new Error('Исходники Python должны содержать UTF-8.');
        return result;
    }
    if(file.encoding!=='base64'||file.content.length>4*Math.ceil(1024**2/3))throw new Error('Некорректное кодирование ресурса Python.');
    let decoded:string;try{decoded=atob(file.content);}catch{throw new Error('Некорректное кодирование ресурса Python.');}
    if(btoa(decoded)!==file.content)throw new Error('Ресурс Python должен содержать канонический base64.');
    return Uint8Array.from(decoded,char=>char.charCodeAt(0));
}
function crc32(data:Uint8Array):number{
    let crc=0xffffffff;
    for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc>>>1^(crc&1?0xedb88320:0);}
    return(crc^0xffffffff)>>>0;
}

/** A deterministic stored ZIP contains only filtered source bytes, restoring the selected package wrapper. */
export function createPythonSourceUpload(source:PackagingFilesResult):File{
    if(!Array.isArray(source.files)||!source.files.length||source.files.length>100)throw new Error('Для Python выберите от 1 до 100 файлов.');
    const prefix=source.rootName?checkedPath(source.rootName)+'/':'';
    if(source.rootName?.includes('/'))throw new Error('Имя выбранной папки Python должно быть переносимым.');
    const seen=new Set<string>(),prefixes=new Map<string,string>();let total=0;
    const files=source.files.map(file=>{
        const name=checkedPath(prefix+file.path),key=name.normalize('NFC').toLowerCase();
        if(seen.has(key)||[...seen].some(other=>other.startsWith(key+'/')||key.startsWith(other+'/')))throw new Error('Пути исходников Python повторяются или конфликтуют.');
        const parts=name.split('/');
        for(let index=1;index<=parts.length;index++){const parent=parts.slice(0,index).join('/'),folded=parent.normalize('NFC').toLowerCase();if(prefixes.has(folded)&&prefixes.get(folded)!==parent)throw new Error('Конфликт регистра или Unicode в пути исходников Python.');prefixes.set(folded,parent);}
        seen.add(key);const data=bytes(file);total+=data.length;
        if(data.length>1024**2||total>5*1024**2)throw new Error('Лимит исходников Python: 1 МиБ на файл и 5 МиБ всего.');
        return{name,data};
    }).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
    if(!files.some(file=>file.name.endsWith('.py')&&file.data.length))throw new Error('В исходниках Python нужен непустой файл .py.');
    const body:Uint8Array<ArrayBuffer>[]=[],index:Uint8Array<ArrayBuffer>[]=[];let offset=0,indexBytes=0;
    for(const file of files){
        const name=encoder.encode(file.name),crc=crc32(file.data),local=new Uint8Array(30),view=new DataView(local.buffer);
        view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint16(6,0x800,true);view.setUint16(12,0x21,true);
        view.setUint32(14,crc,true);view.setUint32(18,file.data.length,true);view.setUint32(22,file.data.length,true);view.setUint16(26,name.length,true);
        const central=new Uint8Array(46),record=new DataView(central.buffer);
        record.setUint32(0,0x02014b50,true);record.setUint16(4,0x0314,true);record.setUint16(6,20,true);record.setUint16(8,0x800,true);record.setUint16(14,0x21,true);
        record.setUint32(16,crc,true);record.setUint32(20,file.data.length,true);record.setUint32(24,file.data.length,true);record.setUint16(28,name.length,true);
        record.setUint32(38,0o100644<<16,true);record.setUint32(42,offset,true);
        body.push(local,name,file.data);index.push(central,name);offset+=local.length+name.length+file.data.length;indexBytes+=central.length+name.length;
    }
    const end=new Uint8Array(22),footer=new DataView(end.buffer);
    footer.setUint32(0,0x06054b50,true);footer.setUint16(8,files.length,true);footer.setUint16(10,files.length,true);footer.setUint32(12,indexBytes,true);footer.setUint32(16,offset,true);
    return new File([...body,...index,end],'python-source.zip',{type:'application/zip',lastModified:0});
}
