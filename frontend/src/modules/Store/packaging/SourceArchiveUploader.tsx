import {Alert,Button,Progress,Space,Typography} from 'antd';
import {FileZipOutlined,UploadOutlined} from '@ant-design/icons';
import {useRef} from 'react';
import type {useSourceUpload} from './useSourceUpload';
import {SourceEntrypointChoice} from './SourceEntrypointChoice';
import {packagingPlatformLabels} from './platformLabels';

/** Ready binary archives use a separate raw stream, while the card still receives the same asset envelope. */
export function SourceArchiveUploader({upload,entrypoint,onEntrypointChange,disabled=false}:{upload:ReturnType<typeof useSourceUpload>;entrypoint:string;onEntrypointChange:(value:string)=>void;disabled?:boolean}){
 const input=useRef<HTMLInputElement>(null),ready=upload.upload?.state==='READY';
 const selected=entrypoint||upload.upload?.metadata?.entrypoint||'',targets=upload.upload?.metadata?.choices.find(choice=>choice.entrypoint===selected)?.targets??[];
 return <div className="tool-packaging__files">
  <Space direction="vertical" size="small" style={{width:'100%'}}>
   <Typography.Text strong><FileZipOutlined/> Готовая поставка MCP</Typography.Text>
   <Typography.Text type="secondary">Готовый MCP-сервер: ZIP, TAR.GZ или исполняемый файл до 256 МБ. Определим способ запуска, встроенный runtime и платформу.</Typography.Text>
   <input ref={input} type="file" hidden disabled={disabled||upload.busy||upload.blocked} aria-label="Готовый архив инструмента" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file&&!disabled&&!upload.busy&&!upload.blocked){onEntrypointChange('');void upload.select(file);}}}/>
   <Space wrap>
    <Button icon={<UploadOutlined/>} disabled={disabled||upload.busy||upload.blocked} onClick={()=>input.current?.click()}>{upload.intent?'Выбрать тот же файл':'Выбрать готовый архив'}</Button>
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
   {upload.error&&<Alert type="error" showIcon message={upload.error}/>}
  </Space>
 </div>;
}
