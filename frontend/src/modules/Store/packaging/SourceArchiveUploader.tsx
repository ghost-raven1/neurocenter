import {Alert,Button,Progress,Space,Typography} from 'antd';
import {FileZipOutlined} from '@ant-design/icons';
import {useRef,useState} from 'react';
import {FileDropZone} from '../../../common/components/FileDropZone/FileDropZone';
import type {useSourceUpload} from './useSourceUpload';
import {SourceEntrypointChoice} from './SourceEntrypointChoice';
import {packagingPlatformLabels} from './platformLabels';

/** MCP archives use a durable upload before runtime inspection and packaging. */
export function SourceArchiveUploader({upload,entrypoint,onEntrypointChange,disabled=false}:{upload:ReturnType<typeof useSourceUpload>;entrypoint:string;onEntrypointChange:(value:string)=>void;disabled?:boolean}){
 const ready=upload.upload?.state==='READY',blocked=disabled||upload.busy||upload.blocked,locked=useRef(blocked),[selectionError,setSelectionError]=useState('');locked.current=blocked;
 const selected=entrypoint||upload.upload?.metadata?.entrypoint||'',targets=upload.upload?.metadata?.choices.find(choice=>choice.entrypoint===selected)?.targets??[];
 return <div className="tool-packaging__files">
  <Space direction="vertical" size="small" style={{width:'100%'}}>
   <Typography.Text strong><FileZipOutlined/> Архив MCP</Typography.Text>
   <Typography.Text type="secondary">ZIP, TAR.GZ или исполняемый файл до 256 МБ. Для исходников Python добавим интерпретатор и зависимости автоматически. Для готовой программы проверим встроенный runtime и платформу.</Typography.Text>
   <FileDropZone label="Архив MCP" title="Перетащите архив или исполняемый файл сюда" hint="ZIP, TAR.GZ или готовая программа до 256 МБ"
    buttonText={upload.intent?'Выбрать тот же файл':'Выбрать архив MCP'} disabled={blocked} busy={upload.busy}
    onReject={message=>{if(!locked.current)setSelectionError(message);}} onFiles={files=>{if(locked.current||files.length!==1)return;setSelectionError('');onEntrypointChange('');void upload.select(files[0]);}}/>
   <Space wrap>
    {ready&&<Button disabled={disabled||upload.busy} onClick={()=>{void upload.forget().then(cleared=>{if(cleared)onEntrypointChange('');});}}>Выбрать другую поставку</Button>}
    {(upload.intent||upload.busy)&&<Button disabled={disabled||upload.phase==='cancelling'} onClick={()=>{void upload.cancel();}}>Отменить загрузку</Button>}
    {upload.blocked&&<Button disabled={disabled} onClick={upload.retryRecovery}>Повторить восстановление</Button>}
    {upload.intent&&!upload.busy&&<Button disabled={disabled} onClick={()=>{void upload.recheck();}}>Проверить загрузку</Button>}
   </Space>
   {upload.phase==='hashing'&&<Typography.Text>Проверяем SHA-256 файла…</Typography.Text>}
   {upload.phase==='uploading'&&<><Progress percent={upload.percent} status="active"/>{upload.percent>=99&&<Typography.Text>Файл передан. Проверяем содержимое и способ запуска…</Typography.Text>}</>}
   {upload.phase==='creating'&&<Typography.Text>Сохраняем запрос загрузки…</Typography.Text>}
   {upload.phase==='recovering'&&<Typography.Text>Проверяем сохранённую загрузку…</Typography.Text>}
   {ready&&<>
    <Typography.Text>{upload.upload!.name} · {(upload.upload!.bytes/1024/1024).toFixed(1)} МБ · SHA-256 проверена</Typography.Text>
    <Typography.Text type="secondary">{targets.map(target=>packagingPlatformLabels[target]||target).join(', ')||'Выберите программу — покажем её платформу'}</Typography.Text>
    <SourceEntrypointChoice candidates={upload.upload!.metadata?.candidates??[]} value={selected} onChange={onEntrypointChange} disabled={disabled||upload.busy}/>
   </>}
   {(selectionError||upload.error)&&<Alert type="error" showIcon message={selectionError||upload.error}/>}
  </Space>
 </div>;
}
