import {Alert,Button,Card,Descriptions,Empty,Form,Input,List,Modal,Select,Space,Tag,Typography} from 'antd';
import {SafetyCertificateOutlined} from '@ant-design/icons';
import {useEffect,useState} from 'react';
import {formatBytes} from '../../../common/utils/format';
import {useWebRestore} from './useWebRestore';
import {restoreTerminal} from './types';
import './WebRestore.less';
const {Text,Paragraph}=Typography;
const labels={queued:'Ожидает исполнителя',running:'Выполняется',ready:'Проверка завершена',succeeded:'Данные восстановлены',failed:'Ошибка',interrupted:'Результат неизвестен',cancelled:'Отменено'};
/** Веб подтверждает восстановление в НОВЫЙ стек; запуск приложений и smoke остаются явным следующим шагом. */
export default function WebRestore({account}:{account:string}){
 const flow=useWebRestore(account),[checkpointId,setCheckpointId]=useState<string>(),[target,setTarget]=useState(''),[confirmation,setConfirmation]=useState(''),[confirmOpen,setConfirmOpen]=useState(false),[now,setNow]=useState(Date.now());
 useEffect(()=>{if(!target&&flow.status?.runner.targetPrefix)setTarget(flow.status.runner.targetPrefix+'-'+crypto.randomUUID().slice(0,8));},[flow.status?.runner.targetPrefix,target]);
 const selected=flow.status?.checkpoints.find(item=>item.id===checkpointId),preview=flow.job?.state==='ready'?flow.job.preview:null;
 useEffect(()=>{if(!preview){setConfirmOpen(false);setConfirmation('');return;}const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[preview]);
 const expired=!!preview&&Date.parse(preview.expiresAt)<=now,locked=!!flow.intent||flow.busy||flow.loading||flow.blocked;
 const canCheck=!!selected&&!!flow.status?.runner.available&&!locked&&/^[a-z0-9][a-z0-9_-]{2,62}$/.test(target)&&target.startsWith((flow.status.runner.targetPrefix??'')+'-');
 return <Card title={<Space><SafetyCertificateOutlined/><span>Восстановление полной копии</span></Space>} extra={<Button loading={flow.loading} disabled={flow.busy} onClick={()=>void flow.refresh()}>Обновить состояние</Button>} className="web-restore">
  <Paragraph>Восстановим проверенную копию всех серверных баз и файлов в <Text strong>новый пустой стек</Text>. Текущая площадка продолжит работу. Приложения нового стека останутся остановлены до отдельной проверки и ввода в работу.</Paragraph>
  {flow.error&&<Alert type="error" showIcon message="Восстановление требует внимания" description={flow.error} className="web-restore__notice"/>}
  {!flow.loading&&!flow.status?.runner.available&&<Alert type="warning" showIcon message="Исполнитель восстановления не подключён" description="Оператор должен настроить отдельный runner и каталог полных копий. Запросы из браузера не запускают shell или Docker." className="web-restore__notice"/>}
  {!flow.intent&&<Form layout="vertical">
   <Form.Item label="Полная копия" extra="Ручной дамп системного каталога не является полной копией сервера."><Select aria-label="Полная копия для восстановления" value={checkpointId} onChange={setCheckpointId} disabled={locked||!flow.status?.runner.available} placeholder="Выберите checkpoint" options={flow.status?.checkpoints.map(item=>({value:item.id,label:item.label+' · '+new Date(item.createdAt).toLocaleString('ru-RU')}))}/></Form.Item>
   {selected&&<Paragraph className="web-restore__hash"><Text type="secondary">SHA-256 копии: </Text><Text code>{selected.sha256}</Text></Paragraph>}
   <Form.Item label="Имя нового стека" extra={flow.status?.runner.targetPrefix?'Начинается с '+flow.status.runner.targetPrefix+'-. Существующие контейнеры и тома отклоняются.':'Назначение задаётся после подключения runner.'}><Input aria-label="Имя нового стека" value={target} onChange={event=>setTarget(event.target.value)} disabled={locked} maxLength={63}/></Form.Item>
   <Button type="primary" loading={flow.busy} disabled={!canCheck} onClick={()=>selected&&void flow.check({checkpointId:selected.id,checkpointSha256:selected.sha256,targetProject:target})}>Проверить копию и назначение</Button>
   {!flow.loading&&flow.status?.runner.available&&!flow.status.checkpoints.length&&<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Полные checkpoint ещё не зарегистрированы исполнителем"/>}
  </Form>}
  {flow.intent&&!flow.job&&<Alert type="info" showIcon message={flow.missing?'Запрос сохранён в этом браузере; сервер пока не нашёл его':'Проверяем сохранённый запрос'} description="При повторе сохраняются исходные requestKey, копия, назначение и подтверждение." className="web-restore__notice"/>}
  {flow.job&&<Space direction="vertical" className="web-restore__content">
   <Space wrap><Tag color={flow.job.state==='succeeded'||flow.job.state==='ready'?'green':flow.job.state==='failed'||flow.job.state==='interrupted'?'error':'processing'}>{labels[flow.job.state]}</Tag><Text type="secondary">Запрос {flow.job.id}</Text></Space>
   <Alert type={flow.job.state==='interrupted'||flow.job.state==='failed'?'warning':flow.job.state==='succeeded'?'success':'info'} showIcon message={flow.job.message}/>
   {(preview??flow.job.preview)&&<Descriptions column={1} size="small" bordered>
    <Descriptions.Item label="Новый стек">{(preview??flow.job.preview)!.targetProject}</Descriptions.Item>
    <Descriptions.Item label="Checkpoint">{(preview??flow.job.preview)!.checkpointId}</Descriptions.Item>
    <Descriptions.Item label="SHA-256 копии"><Text code className="web-restore__hash">{(preview??flow.job.preview)!.checkpointSha256}</Text></Descriptions.Item>
    <Descriptions.Item label="Состав">Баз: {(preview??flow.job.preview)!.impact.databases.length}; файлов: {(preview??flow.job.preview)!.impact.files}; {formatBytes((preview??flow.job.preview)!.impact.bytes)}</Descriptions.Item>
    <Descriptions.Item label="Серверные данные">Скиллы, проекты, сохранённые копии и runtime-артефакты. Локальные файлы компьютеров не входят.</Descriptions.Item>
   </Descriptions>}
   {preview&&<><Text type="secondary">Проверка действительна до {new Date(preview.expiresAt).toLocaleTimeString('ru-RU')}. SHA и назначение будут повторно проверены перед записью.</Text><Button type="primary" danger disabled={expired||flow.busy||flow.blocked||!flow.status?.runner.available} onClick={()=>setConfirmOpen(true)}>Подтвердить восстановление…</Button>{expired&&<Alert type="warning" message="Срок проверки истёк. Выполните новую проверку."/>}</>}
  </Space>}
  <Space wrap className="web-restore__actions">
   {flow.intent&&!restoreTerminal(flow.job)&&!flow.blocked&&<Button disabled={flow.busy||flow.loading} onClick={()=>void flow.repeat()}>Повторить сохранённый запрос</Button>}
   {flow.job?.state==='queued'&&<Button disabled={flow.busy} onClick={()=>void flow.cancel()}>Отменить ожидание</Button>}
   {flow.intent&&(restoreTerminal(flow.job)||flow.missing)&&<Button disabled={flow.busy||flow.loading} onClick={()=>void flow.newCheck()}>Новая проверка</Button>}
  </Space>
  {!!flow.status?.jobs.length&&<List size="small" header="Последние запросы этого аккаунта" dataSource={flow.status.jobs.slice(0,5)} renderItem={item=><List.Item><Space wrap><Text>{item.kind==='preview'?'Проверка':'Восстановление'}</Text><Text type="secondary">{new Date(item.createdAt).toLocaleString('ru-RU')}</Text><Tag>{labels[item.state]}</Tag></Space></List.Item>}/>}
  <Modal open={confirmOpen&&!!preview} title="Подтвердите восстановление в новый стек" okText="Восстановить данные" cancelText="Назад" okButtonProps={{danger:true,disabled:expired||confirmation!=='RESTORE '+preview?.targetProject||flow.busy}} confirmLoading={flow.busy} onCancel={()=>setConfirmOpen(false)} onOk={()=>{if(preview)void flow.confirm(preview,confirmation).then(()=>setConfirmOpen(false));}}>
   <Paragraph>Будут созданы новые серверные базы и тома. Текущий стек не перезаписывается. После переноса приложения останутся остановлены; успешный перенос данных ещё не подтверждает готовность новой площадки.</Paragraph>
   <Paragraph>Введите <Text code>RESTORE {preview?.targetProject}</Text></Paragraph>
   <Input aria-label="Подтверждение восстановления" value={confirmation} onChange={event=>setConfirmation(event.target.value)} autoComplete="off"/>
  </Modal>
 </Card>;
}
