import { Alert, Button, Progress, Space, Typography } from 'antd';
import {useEffect,useRef,useState} from 'react';
import {packagingApi} from './api';
import {useAuthRequestOwner} from '../../../features/UserBlock/useAuthRequestOwner';
import {errorMessage} from '../../../common/utils/errorMessage';
import type { ToolBuild } from './types';

interface Props {
    job?: ToolBuild;
    name: string;
    active?: boolean;
}

/** Закрытие окна сохраняет серверную сборку; повтор после отказа возвращает заполненные исходники. */
export function PackagingBuildStatus({ job, name, active = true }: Props) {
    const {captureOwner}=useAuthRequestOwner();
    const [exporting,setExporting]=useState<'asset'|'supply'|undefined>(),[exportError,setExportError]=useState(''),[requested,setRequested]=useState(false);
    const generation=useRef(0);
    const request=useRef<AbortController>(),objectUrls=useRef(new Map<string,ReturnType<typeof setTimeout>>());
    const context=useRef({id:job?.id,state:job?.state,active,captureOwner});context.current={id:job?.id,state:job?.state,active,captureOwner};
    useEffect(()=>{generation.current++;setExporting(undefined);setExportError('');setRequested(false);return()=>{
        generation.current++;request.current?.abort();request.current=undefined;
        for(const [url,timer] of objectUrls.current){clearTimeout(timer);URL.revokeObjectURL(url);}objectUrls.current.clear();
    };},[job?.id,job?.state,captureOwner,active]);
    const download=async(kind:'asset'|'supply')=>{
        if(!context.current.active||context.current.id!==job?.id||request.current||!job?.id||job.state!=='SUCCEEDED')return;
        const owns=captureOwner();if(!owns())return;
        const current=++generation.current,controller=new AbortController();request.current=controller;
        const currentRequest=()=>owns()&&generation.current===current&&!controller.signal.aborted&&context.current.active
            &&context.current.id===job.id&&context.current.state==='SUCCEEDED'&&context.current.captureOwner===captureOwner;
        setExporting(kind);setExportError('');setRequested(false);
        try{
            const value=kind==='supply'?await packagingApi.supply(job.id,controller.signal):await packagingApi.assetDocument(job.id,controller.signal);
            if(!currentRequest())return;
            const link=document.createElement('a');
            if(kind==='supply'){
                link.href=value;link.download='';link.click();setRequested(true);
            }else{
                const url=URL.createObjectURL(new Blob([value],{type:'application/json'}));
                try{link.href=url;link.download=String(job.result?.assetId||'neurocenter-asset')+'.asset.json';link.click();}
                catch(cause){URL.revokeObjectURL(url);throw cause;}
                const timer=setTimeout(()=>{URL.revokeObjectURL(url);objectUrls.current.delete(url);},0);objectUrls.current.set(url,timer);
            }
        }catch(cause){if(currentRequest())setExportError(errorMessage(cause,kind==='supply'?'Не удалось скачать поставку.':'Не удалось скачать описание ассета.'));}
        finally{if(request.current===controller){request.current=undefined;if(currentRequest())setExporting(undefined);}}
    };
    const failed = job?.state === 'FAILED';
    const succeeded = job?.state === 'SUCCEEDED';
    const percent = Math.max(0, Math.min(100, job?.percent ?? 0));
    return <div className="tool-packaging__progress" role="status" aria-live="polite">
        <Typography.Text strong className="tool-packaging__progress-title">{job?.result?.name ?? job?.name ?? name}</Typography.Text>
        <Typography.Paragraph type="secondary">{succeeded ? 'Инструмент добавлен в общий каталог' : failed ? 'Упаковка остановлена' : 'Готовим инструмент к установке'}</Typography.Paragraph>
        <Progress percent={percent} aria-label="Прогресс упаковки" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} status={failed ? 'exception' : succeeded ? 'success' : 'active'} />
        <Typography.Paragraph>{job?.message ?? 'Проверяем, принят ли запрос, и загружаем прогресс…'}</Typography.Paragraph>
        {failed && <Alert type="error" showIcon message={job?.error || 'Не удалось завершить сборку.'} description="Исходники и настройки сохранены. Вернитесь к ним, исправьте причину и повторите упаковку." />}
        {succeeded && job?.result?.assetId && <Space wrap>
            <Button type="primary" onClick={()=>{void download('supply');}} loading={exporting==='supply'} disabled={!active||!!exporting}>Скачать поставку</Button>
            <Button type="link" onClick={()=>{void download('asset');}} loading={exporting==='asset'} disabled={!active||!!exporting}>Скачать asset.json</Button>
        </Space>}
        {requested && <Typography.Paragraph type="secondary">Запрос на скачивание передан браузеру.</Typography.Paragraph>}
        {exportError && <Alert type="error" showIcon message={exportError} />}
        {succeeded ? <Alert type="success" showIcon message="Готово к следующему шагу" description="Откройте карточку, выберите проект и установите инструмент на нужный компьютер." />
            : !failed && <Typography.Paragraph type="secondary" className="tool-packaging__background-note">Можно скрыть окно и продолжить работу. Упаковка продолжится; откройте её снова, чтобы посмотреть результат.</Typography.Paragraph>}
    </div>;
}
