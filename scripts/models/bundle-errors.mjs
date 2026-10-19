const messages={
    MODEL_MANAGED_CONFLICT:'Существующий тег модели не принадлежит проверенной поставке. Данные сохранены. Для регистрации прежнего комплекта выполните npm run models:prepare -- --adopt-from-git ORIG_HEAD; пользовательский тег сохраните под другим именем.',
    MODEL_GIT_ADOPTION:'Не удалось подтвердить прежнюю поставку из Git. Нужен доступный commit-предок HEAD с полной описью и точным совпадением локальных тегов и SHA весов. Данные сохранены.',
    ENOSPC:'Недостаточно свободного места для подготовки моделей. Освободите место на разделе проекта и повторите запуск.',
    EDQUOT:'Квота диска исчерпана. Увеличьте квоту пользователя проекта или освободите место.',
    EACCES:'Нет прав на чтение или запись файлов моделей. Проверьте владельца и права каталога data/embedding.',
    EPERM:'Операционная система запретила доступ к файлам моделей. Проверьте права каталога data/embedding.',
    EROFS:'Раздел с файлами моделей доступен только для чтения.',
    ENOENT:'Не найден файл или каталог поставки моделей. Проверьте полноту checkout и путь к описи.',
    ENOTDIR:'В пути хранилища моделей найден файл вместо каталога.',
    ELOOP:'Хранилище моделей содержит недопустимую символическую ссылку.',
    MODEL_NETWORK:'Не удалось загрузить модели с GitHub. Проверьте сеть, DNS и доступ к GitHub Releases.',
    MODEL_TLS:'Не удалось проверить TLS-сертификат загрузки моделей. Проверьте сертификаты и настройки сетевого прокси.',
    MODEL_DOWNLOAD_TIMEOUT:'Истекло время загрузки части модели. Проверьте сеть и повторите запуск; проверенные части сохранены.',
    MODEL_INTEGRITY:'Размер или SHA-256 файла модели не совпал с закреплённой поставкой. Существующие файлы сохранены; проверьте комплект через npm run models:verify.',
    MODEL_STORAGE:'Хранилищу моделей нужен обычный каталог внутри проекта, без символических ссылок.',
    MODEL_MANIFEST:'Опись моделей не соответствует закреплённым model.lock.json. Обновите checkout целиком и повторите запуск.',
    MODEL_BUNDLE_USAGE:'Некорректные параметры подготовки моделей. Справка: npm run models:prepare -- --help.',
    MODEL_BUNDLE_PROTOCOL:'Подготовка моделей завершилась без полного отчёта. Проверьте целостность checkout и версию скриптов.',
    MODEL_BUNDLE_FAILED:'Команда подготовки моделей завершилась с ошибкой. Код завершения и диагностика указаны отдельно.',
    MODEL_BUNDLE_TIMEOUT:'Подготовка моделей превысила предел ожидания — 2 часа. Проверенные части сохранены.',
    ENOBUFS:'Вывод подготовки моделей превысил допустимый объём; команда остановлена.',
    MODEL_BUNDLE_UNKNOWN:'Не удалось подготовить модели. Проверьте диагностику команды и повторите запуск.',
};
const network=new Set(['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
const bytes=value=>Number.isSafeInteger(value)&&value>=0;
const gib=value=>(value/1024**3).toFixed(2)+' ГиБ';

/** Публичная причина не содержит сырые исключения, локальные пути или подписанные URL загрузки. */
export function modelBundleFailure(error) {
    const source=error?.code||error?.cause?.code;
    let code=source;
    if(!Object.hasOwn(messages,code)) {
        const detail=typeof error?.message==='string'?error.message:'';
        if(code==='MODEL_DOWNLOAD_HTTP'||/^GitHub не выдал часть модели \(HTTP \d{3}\)\.$/.test(detail)) {
            const status=Number(error?.status||detail.match(/HTTP (\d{3})/)?.[1]);
            if(Number.isInteger(status)&&status>=100&&status<=599)return {code:'MODEL_DOWNLOAD_HTTP',status,
                message:`GitHub не выдал часть модели (HTTP ${status}). `+(status===404?'Проверьте доступность закреплённого release.'
                    :status===403||status===429?'Доступ ограничен; проверьте сетевой прокси и повторите позже.':'Проверьте доступ к GitHub Releases и повторите загрузку.')};
        }
        if(/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(String(source)))code='MODEL_TLS';
        else if(network.has(source)||detail==='fetch failed')code='MODEL_NETWORK';
        else if(['TimeoutError','AbortError'].includes(error?.name))code='MODEL_DOWNLOAD_TIMEOUT';
        else if(/SHA|размер|изменился/.test(detail))code='MODEL_INTEGRITY';
        else if(/символическ|путь хранилища|Хранилищу моделей/.test(detail))code='MODEL_STORAGE';
        else if(/опись|поставки отличаются|model.lock|закреплённый GitHub release|манифест модели/.test(detail))code='MODEL_MANIFEST';
        else code='MODEL_BUNDLE_UNKNOWN';
    }
    const message=messages[code];
    if(code==='ENOSPC'&&bytes(error?.requiredBytes)&&bytes(error?.availableBytes))return {code,
        message:`Недостаточно места для моделей: требуется свободно ${gib(error.requiredBytes)}, доступно ${gib(error.availableBytes)}. В расчёт включён резерв 1 ГиБ.`,
        requiredBytes:error.requiredBytes,availableBytes:error.availableBytes};
    return {code,message};
}
