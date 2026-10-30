import {buildDevSnapshotImage,inspectDevSnapshotImage} from './dev-snapshots.mjs';
import {writeCatalogRebuildRequest} from './catalog-rebuild-request.mjs';

/** A rebuild prepares the exact host bridge before asking Catalog to update its bundled packages. */
export async function prepareCurrentDevPackages({root,node,environment=process.env,output,next}){
    next('Подготовка текущей поставки моста');
    const {prepareDevBridge}=await import('./dev-bridge-runtime.mjs');
    const supply=await prepareDevBridge({root,node,environment,output});
    if(supply?.prepared!==true)throw Error('Текущая поставка моста не подготовлена. Прежняя установка и каталог сохранены; повторите пересборку после восстановления зависимостей.');
    next('Обновление встроенных пакетов каталога');
    const request=await writeCatalogRebuildRequest({root});
    output.info('Каталог','Запрос обновления сохранён. После запуска Catalog проверит права и подготовит новые версии; ход и результат доступны в «Операциях».');
    return request;
}

/** Snapshot tooling is optional; a failed image never blocks the current bridge or the seven core services. */
export async function optionalDevSnapshotImage({root,environment=process.env,output,build=false}){
    let interrupted;
    const interrupt=()=>{interrupted='SIGINT';},terminate=()=>{interrupted='SIGTERM';};
    process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
    try{
        const image=build?await buildDevSnapshotImage(root,environment):await inspectDevSnapshotImage(root,environment);
        if(interrupted)throw Object.assign(Error('Подготовка снимков прервана ('+interrupted+').'),{code:'ABORT_ERR'});
        return image;
    }catch(error){
        if(interrupted)throw Object.assign(Error('Подготовка снимков прервана ('+interrupted+').'),{code:'ECANCELED',signal:interrupted});
        if(error?.code==='ABORT_ERR'||error?.name==='AbortError')throw error;
        output.warning('Проверка снимков недоступна: '+error.message+' Основной запуск не заблокирован; подписи, ключи и прежние снимки сохранены.');return undefined;
    }finally{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);}
}
