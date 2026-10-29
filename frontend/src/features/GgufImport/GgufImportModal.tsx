import {Alert,Button,Input,Modal,Progress,Select,Space,Typography} from 'antd';
import {UploadOutlined} from '@ant-design/icons';
import {useId,useRef} from 'react';
import type {ICatalogModel} from '../ModelCatalog/types';
import {formatBytes} from './model';
import {useGgufImport} from './useGgufImport';
import './GgufImport.less';

export interface GgufImportModalProps {onClose:()=>void;onImported:(model:ICatalogModel)=>void|Promise<void>;}

/** A verified file creates a catalog record; runtime activation and inference readiness remain separate. */
export function GgufImportModal({onClose,onImported}:GgufImportModalProps):JSX.Element{
    const value=useGgufImport(onImported),fileInput=useRef<HTMLInputElement>(null),id=useId();
    const receipt=value.receipt,busy=value.phase!=='idle',accepted=receipt?.state==='ACCEPTED',cancelled=receipt?.state==='CANCELLED';
    const ready=receipt?.state==='READY',expired=!!receipt&&!accepted&&Date.parse(receipt.expiresAt)<=Date.now();
    const mayWrite=value.canWrite&&value.availability.enabled&&!value.journalError;
    const maximum=receipt?.limits.maximumBytes??value.policy?.maximumBytes;
    const canChoose=mayWrite&&!busy&&!ready&&!accepted&&!cancelled;
    const canUpload=mayWrite&&!busy&&!!value.file&&!ready&&!accepted&&!cancelled&&!expired&&(!!receipt||!!value.policy&&!value.limitsError);
    const status=value.phase==='creating'?'Подготавливаем загрузку…':value.phase==='uploading'
        ?value.file&&value.loaded>=value.file.size?'Файл передан браузером. Сервер проверяет GGUF и SHA-256…':'Передаём файл на сервер…'
        :value.phase==='accepting'?'Сохраняем модель в каталоге…':value.phase==='cancelling'?'Проверяем отмену импорта…':value.phase==='reading'?'Проверяем состояние…'
        :accepted?'Модель сохранена в каталоге':cancelled?'Импорт отменён':ready?'GGUF проверен сервером'
        :receipt?.state==='UPLOADING'?'Прежняя передача ещё не подтверждена':receipt?'Файл ожидает передачи':value.key?'Сохранён номер прежнего импорта':'Выберите файл GGUF';
    return <Modal open centered width={600} title="Импорт модели из GGUF" className="gguf-import" onCancel={onClose} maskClosable={false}
        footer={<Space wrap>
            <Button onClick={onClose}>{busy?'Скрыть':'Закрыть'}</Button>
            {value.key&&!accepted&&!cancelled&&<Button danger loading={value.phase==='cancelling'} disabled={!value.canWrite||!!value.journalError||value.phase==='cancelling'} onClick={()=>{void value.cancel();}}>Отменить импорт</Button>}
            {(accepted||cancelled)&&<Button disabled={busy||!value.canWrite||!!value.journalError} onClick={value.reset}>Новый импорт</Button>}
        </Space>}>
        <Typography.Paragraph type="secondary">Выберите один полный файл .gguf для чата или эмбеддингов. После импорта запуск и проверка хостинга выполняются отдельно.</Typography.Paragraph>
        {!value.canWrite&&<Alert type="info" showIcon message="Импорт доступен главному администратору."/>}
        {!value.availability.enabled&&<Alert type="info" showIcon message={value.availability.reason} description="Прежнюю загрузку можно проверить или отменить."/>}
        {value.journalError&&<Alert type="warning" showIcon message="Нужна проверка сохранённого импорта" description={value.journalError}/>}
        {value.error&&<div role="alert"><Alert type="warning" showIcon message={value.error}/></div>}
        {value.limitsError&&<Alert type="warning" showIcon message="Лимиты новой загрузки не подтверждены" description={value.limitsError}
            action={<Button size="small" disabled={busy} onClick={()=>{void value.refreshLimits();}}>Проверить лимиты</Button>}/>}
        <div className="gguf-import__status" role="status" aria-live="polite"><Typography.Text strong>{status}</Typography.Text>
            {value.key&&<Button size="small" disabled={busy||!value.canWrite||!!value.journalError} onClick={()=>{void value.recover();}}>Проверить состояние</Button>}</div>
        {value.missing&&<Alert type="info" showIcon message="Сервер пока не нашёл прежний запрос" description="Это не подтверждает отказ. Для повтора выберите тот же файл; номер запроса сохранён."/>}
        {expired&&!cancelled&&<Alert type="warning" showIcon message="Срок этого импорта истёк. Отмените его и начните новый."/>}
        {!accepted&&!cancelled&&!ready&&<div className="gguf-import__file">
            <input ref={fileInput} type="file" accept=".gguf" hidden aria-label="Выбрать файл GGUF" onChange={event=>{
                const file=event.target.files?.[0];event.target.value='';if(file)value.selectFile(file);
            }}/>
            <Space wrap><Button icon={<UploadOutlined aria-hidden="true"/>} disabled={!canChoose} onClick={()=>fileInput.current?.click()}>{receipt?'Выбрать тот же файл':'Выбрать файл GGUF'}</Button>
                <Button type="primary" disabled={!canUpload} loading={value.phase==='creating'||value.phase==='uploading'} onClick={()=>{void value.upload();}}>{value.key?'Продолжить загрузку':'Загрузить и проверить'}</Button></Space>
            {value.file?<Typography.Text>{value.file.name} · {formatBytes(value.file.size)}</Typography.Text>
                :receipt&&<Typography.Text>Для продолжения выберите {receipt.fileName} · {formatBytes(receipt.bytes)}</Typography.Text>}
            {maximum&&<Typography.Text type="secondary">{receipt?'Лимит этого импорта':'Действующий лимит'}: {formatBytes(maximum)}</Typography.Text>}
            {receipt&&value.policy&&receipt.limits.maximumBytes!==value.policy.maximumBytes&&<Typography.Text type="secondary">Новые импорты: до {formatBytes(value.policy.maximumBytes)}. Для этой загрузки сохранены прежние правила.</Typography.Text>}
            {!receipt&&value.policy&&!busy&&<Button type="link" size="small" onClick={()=>{void value.refreshLimits();}}>Обновить лимит</Button>}
        </div>}
        {value.phase==='uploading'&&value.file&&<div><Progress percent={Math.floor(value.loaded/value.file.size*100)} status="active"/><Typography.Text type="secondary">Процент показывает передачу из браузера. Проверка файла подтверждается отдельно.</Typography.Text></div>}
        {busy&&<Typography.Paragraph type="secondary">Закрытие окна прервёт передачу из браузера. Уже отправленный запрос может завершиться на сервере: номер импорта сохранится для проверки.</Typography.Paragraph>}
        {receipt&&(ready||accepted)&&<div className="gguf-import__verified"><Typography.Text>{receipt.fileName} · {formatBytes(receipt.bytes)}</Typography.Text>
            <Typography.Text type="secondary">GGUF v{receipt.metadata?.version} · {receipt.metadata?.architecture}</Typography.Text></div>}
        {ready&&<form id={id} className="gguf-import__form" onSubmit={event=>{event.preventDefault();if(mayWrite&&!busy&&!expired)void value.accept();}}>
            <label htmlFor={id+'-name'}>Название модели</label><Input id={id+'-name'} value={value.name} disabled={busy||value.acceptLocked} maxLength={128} onChange={event=>value.change('name',event.target.value)}/>
            <label htmlFor={id+'-capability'}>Назначение</label><Select id={id+'-capability'} aria-label="Назначение модели" value={value.capability} disabled={busy||value.acceptLocked}
                options={[{value:'chat',label:'Чат'},{value:'embedding',label:'Эмбеддинги'}]} onChange={next=>value.change('capability',next)}/>
            <details><summary>Описание · необязательно</summary><label htmlFor={id+'-description'}>Описание</label><Input.TextArea id={id+'-description'} rows={2} value={value.description} disabled={busy||value.acceptLocked} maxLength={4000} onChange={event=>value.change('description',event.target.value)}/></details>
            {value.acceptLocked&&!busy&&<Typography.Text type="secondary">Предыдущее сохранение не подтверждено. Проверьте состояние или повторите те же параметры.</Typography.Text>}
            <Button type="primary" htmlType="submit" loading={value.phase==='accepting'} disabled={!mayWrite||busy||expired||!value.name.trim()}>{value.acceptLocked?'Повторить сохранение':'Добавить модель в каталог'}</Button>
        </form>}
        {accepted&&<Alert type="success" showIcon message="Модель добавлена в каталог" description="Для использования запустите хостинг и дождитесь проверки готовности."/>}
        {accepted&&value.model&&!value.notified&&<Button disabled={busy} onClick={()=>{void value.notify();}}>Обновить каталог</Button>}
        {value.key&&<details className="gguf-import__receipt"><summary>Квитанция импорта</summary><Typography.Text code>{value.key}</Typography.Text>
            {receipt?.sha256&&<div>SHA-256 файла: <Typography.Text code>{receipt.sha256}</Typography.Text></div>}</details>}
    </Modal>;
}
