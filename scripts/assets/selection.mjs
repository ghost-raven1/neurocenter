import {createInterface} from 'node:readline';
import {downloadArtifacts,selectAssets} from '@neurocenter/asset-contract';
import {readAssetSupply,readSourcePin} from './supply.mjs';
import {assetEnvironment} from './environment.mjs';
import {assetRetrievalFetch} from './retrieval.mjs';
import {previousAssetSelection,readSelectionFile,saveAssetSelection} from './selection-state.mjs';

const unavailable=new Set(['UNAVAILABLE','ASSET_RETRIEVAL_UNAVAILABLE','ASSET_METADATA_MISSING','ASSET_ARTIFACTS_MISSING']);
const clean=value=>String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').slice(0,180);
const size=bytes=>bytes>=1024**3?`${(bytes/1024**3).toFixed(2)} ГиБ`:bytes>=1024**2?`${(bytes/1024**2).toFixed(1)} МиБ`:`${bytes} Б`;

/** Numeric choices refer only to the displayed immutable source, not shell arguments. */
export function parseAssetSelection(text,choices,previous){
    if(text===null)return {skip:true};
    const value=text.trim().toLowerCase();
    if(!value)return {ids:previous};
    if(['s','skip','пропустить'].includes(value))return {skip:true};
    if(['none','нет','0'].includes(value))return {ids:[]};
    if(['all','все'].includes(value))return {ids:choices.filter(choice=>!choice.disabled).map(choice=>choice.id)};
    if(value.length>4096||!/^\d+(?:[\s,]+\d+)*$/.test(value))throw Error('Введите номера через запятую, all, none или s.');
    const indexes=[...new Set(value.split(/[\s,]+/).map(Number))];
    if(indexes.some(index=>!Number.isSafeInteger(index)||index<1||index>choices.length||choices[index-1].disabled))throw Error('Выберите только доступные номера из списка.');
    return {ids:indexes.map(index=>choices[index-1].id)};
}

/** Summaries contain versions, closure sizes and receipt hints; binary bytes are not opened. */
export function assetSelectionChoices(supply,{withoutModels=false,receipt}={}){
    const records=new Map(supply.assets.filter(record=>record.current).map(record=>[record.asset.id,record]));
    return supply.index.assets.filter(entry=>entry.current&&records.has(entry.id)&&(!withoutModels||entry.kind!=='model')).map(entry=>{
        const record=records.get(entry.id);
        const {asset}=record,closure=selectAssets(supply.assets,[asset.id]),artifacts=new Map();
        for(const item of closure)for(const artifact of item.asset.kind==='model'?[]:downloadArtifacts(item.asset))artifacts.set(artifact.sha256,artifact);
        const previous=receipt?.assets?.find(item=>item.id===asset.id);
        return {id:asset.id,name:asset.card.name||asset.id,kind:asset.kind,version:asset.card.revision||asset.version,
            bytes:[...artifacts.values()].reduce((sum,item)=>sum+item.bytes,0),
            disabled:withoutModels&&closure.some(item=>item.asset.kind==='model'),
            status:previous?(previous.sha256===record.sha256?'подготовлен ранее':'обновление'):'новый',
            dependencies:closure.filter(item=>item!==record).map(item=>item.asset.id)};
    });
}

function terminalQuestion(input,terminalOutput){
    const terminal=createInterface({input,output:terminalOutput,terminal:true});
    return {close:()=>terminal.close(),ask:prompt=>new Promise((resolve,reject)=>{
        let settled=false;
        const done=(error,value)=>{if(settled)return;settled=true;terminal.off('close',closed);terminal.off('SIGINT',interrupt);error?reject(error):resolve(value);};
        const closed=()=>done(null,null),interrupt=()=>done(Object.assign(Error('Выбор ассетов отменён. Прежние сервисы и файлы сохранены.'),{code:'ECANCELED',signal:'SIGINT'}));
        terminal.once('close',closed);terminal.once('SIGINT',interrupt);
        if(terminal.closed)closed();else terminal.question(prompt,value=>done(null,value));
    })};
}

/** Startup chooses IDs before the existing SHA-verified prefetch, without requiring running services. */
export async function selectStartupAssets({root,environment=process.env,output,withoutModels=false,input=process.stdin,terminalOutput=process.stdout},
    {readSupply=readAssetSupply,request=assetRetrievalFetch(),question}={}){
    const merged=await assetEnvironment(root,environment),gate=merged.ASSET_STARTUP_SELECTION??'on';
    if(!['on','off','true','false','1','0'].includes(gate))throw Error('ASSET_STARTUP_SELECTION должен быть on или off.');
    const interactive=!['off','false','0'].includes(gate)&&input.isTTY===true&&terminalOutput.isTTY===true;
    const previous=await previousAssetSelection(root);
    // A fresh headless run keeps the established CLI default; accepted intent never needs a terminal.
    if(!interactive&&!previous)return {};
    const metadata={root,environment:merged,fetch:request,signal:AbortSignal.timeout(60000)};
    let supply;
    try{
        if(interactive)supply=await readSupply(metadata);
        else{
            const overview=await readSupply({...metadata,ids:[]});
            const current=new Set(overview.index.assets.filter(entry=>entry.current&&(!withoutModels||entry.kind!=='model')).map(entry=>entry.id));
            supply=await readSupply({...metadata,ids:previous.selected.filter(id=>current.has(id)),
                expectedRepository:overview.pin.repository,expectedCommit:overview.pin.commit,expectedRevision:overview.revision});
        }
    }
    catch(error){if(!unavailable.has(error.code)&&error.name!=='TimeoutError')throw error;output.warning('Список ассетов сейчас недоступен; запуск продолжится с сохранёнными файлами. Выбор сохранён.');return {skip:true,reason:'assets-unavailable'};}
    const receipt=await readSelectionFile(root,'assets-ready.json'),choices=assetSelectionChoices(supply,{withoutModels,receipt});
    const allowed=new Set(choices.filter(choice=>!choice.disabled).map(choice=>choice.id));
    const ids=(previous?.selected||[]).filter(id=>allowed.has(id));
    if(previous&&ids.length!==previous.selected.length)output.info('Прежний выбор','Ассеты, отсутствующие в текущей поставке или недоступные этому профилю, исключены. Новые ID не добавлены.');
    let selected={ids};
    if(interactive){
        output.info('Ассеты для скачивания и обновления',`${supply.pin.repository} · commit ${supply.pin.commit} · ${withoutModels?'без моделей':'полная поставка'}`);
        output.info('Выбор','Enter — прежний набор; номера через запятую — новый набор; all — все; none — ничего; s — пропустить сейчас.');
        choices.forEach((choice,index)=>output.info(`${index+1}. [${ids.includes(choice.id)?'x':' '}] ${clean(choice.name)}`,
            `${clean(choice.id)} · ${clean(choice.kind)} · ${clean(choice.version)} · ${size(choice.bytes)} с зависимостями · ${choice.disabled?'нужна модель: профиль full':choice.status}`));
        output.info('Загрузка','Проверяются только выбранные версии и их точные зависимости. Уже проверенные SHA не скачиваются повторно; карточки и установки не меняются.');
        const terminal=question?{ask:question,close(){}}:terminalQuestion(input,terminalOutput);
        try{
            for(;;){
                const answer=await terminal.ask('  Выберите ассеты: ');
                try{selected=parseAssetSelection(answer,choices,ids);break;}
                catch(error){output.warning(error.message);}
            }
        }finally{terminal.close();}
    }else output.info('Выбор ассетов',`Без TTY используется прежний набор: ${ids.length}. Новые ID не добавляются.`);
    if(selected.skip)return {skip:true,reason:'assets-skipped'};
    const planned=selectAssets(supply.assets,selected.ids),artifacts=new Map();
    for(const record of planned)for(const artifact of record.asset.kind==='model'?[]:downloadArtifacts(record.asset))artifacts.set(artifact.sha256,artifact);
    output.info('Подтверждённый набор',`${selected.ids.length} выбранных ассетов, ${planned.length} вместе с зависимостями; ${size([...artifacts.values()].reduce((sum,item)=>sum+item.bytes,0))} файлов поставки. Повторно загружаются только отсутствующие SHA.`);
    const current=await readSourcePin(root);
    if(current.lockSha256!==supply.lockSha256)throw Object.assign(Error('Источник ассетов изменился во время выбора. Повторите запуск; файлы сохранены.'),{code:'ASSET_SOURCE_CHANGED'});
    await saveAssetSelection(root,{pin:supply.pin,ids:selected.ids,withoutModels});
    return {ids:selected.ids,expectedRepository:supply.pin.repository,expectedCommit:supply.pin.commit,expectedRevision:supply.revision};
}
