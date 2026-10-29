import type {RuntimeLimitPolicy} from '@neurocenter/runtime-limits';
export interface LimitField {key:string;label:string;unit:string;}
export const limitFields:Record<keyof RuntimeLimitPolicy,LimitField[]>={
    textKnowledge:[
        {key:'documents',label:'Файлов в загрузке',unit:'шт.'},{key:'fileBytes',label:'Размер файла',unit:'байт'},
        {key:'batchBytes',label:'Размер всей загрузки',unit:'байт'},{key:'pathBytes',label:'Длина пути',unit:'байт'},
        {key:'queryBytes',label:'Поисковый запрос',unit:'байт'},{key:'sources',label:'Источников в результате',unit:'шт.'},{key:'excerptBytes',label:'Длина цитаты',unit:'байт'},
    ],
    ggufImport:[
        {key:'maximumBytes',label:'Размер файла GGUF',unit:'байт'},{key:'storageQuotaBytes',label:'Общая квота импортов',unit:'байт'},
        {key:'maximumPendingImports',label:'Незавершённых импортов',unit:'шт.'},{key:'activeUploads',label:'Одновременных загрузок',unit:'шт.'},
        {key:'diskReserveBytes',label:'Резерв свободного диска',unit:'байт'},{key:'uploadTimeoutMs',label:'Таймаут загрузки',unit:'мс'},
        {key:'checkIntervalMs',label:'Интервал проверки',unit:'мс'},{key:'retentionMs',label:'Срок хранения импорта',unit:'мс'},
        {key:'metadataBytes',label:'Бюджет метаданных',unit:'байт'},{key:'metadataPairs',label:'Полей метаданных',unit:'шт.'},
        {key:'tensorCount',label:'Количество тензоров',unit:'шт.'},{key:'arrayElements',label:'Элементов массива',unit:'шт.'},
        {key:'stringBytes',label:'Длина строки метаданных',unit:'байт'},
        {key:'runtimeRequestTimeoutMs',label:'Таймаут запроса к хостингу',unit:'мс'},{key:'runtimeResponseBytes',label:'Ответ хостинга',unit:'байт'},
    ],
};
