/** Прерывание дожидается очистки staging и освобождения блокировки вместо немедленного выхода. */
export async function prepareAssetsWithCancellation(options) {
    const controller=new AbortController();
    const cancel=signal=>controller.abort(Object.assign(new Error('Подготовка поставки прервана. Проверенный кэш сохранён.'),{code:'ECANCELED',signal}));
    const interrupt=()=>cancel('SIGINT'),terminate=()=>cancel('SIGTERM');
    process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
    try {
        const {syncAssets}=await import('./sync.mjs');
        return await syncAssets({...options,signal:controller.signal});
    } finally {process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);}
}
