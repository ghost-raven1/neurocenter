function formatBytes(bytes) {
    const units=['Б','КиБ','МиБ','ГиБ'];let index=0,value=bytes;
    while(value>=1024&&index<units.length-1) {value/=1024;index++;}
    return `${index?value.toFixed(1):value} ${units[index]}`;
}

/** Диагностика содержит только стадию и счётчики, без локальных путей или адресов загрузки. */
export function formatAssetProgress(value) {
    if(!Number.isSafeInteger(value.completed)||!Number.isSafeInteger(value.total)||value.total<1)return value.message;
    if(value.unit==='files')return `${value.message} ${value.completed}/${value.total} файлов`;
    const percent=Math.min(100,Math.floor(value.completed/value.total*100));
    return `${value.message} ${percent}% · ${formatBytes(value.completed)} / ${formatBytes(value.total)}`;
}

/** Смена стадии видна сразу; потоковые счётчики обновляются не чаще одного раза в две секунды. */
export function assetProgressReporter(write=value=>console.error(value),now=Date.now) {
    let last=0,stage,message;
    return value=>{
        const current=now();
        if(value.stage!==stage||value.message!==message||current-last>=2000||value.stage==='ready') {
            write(formatAssetProgress(value));last=current;stage=value.stage;message=value.message;
        }
    };
}
