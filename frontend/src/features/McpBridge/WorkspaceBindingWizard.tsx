import {Alert,Button,Collapse,Modal,Select,Space,Typography} from 'antd';
import type {useBridge} from './useBridge';
import type {TWorkspaceBindingMode} from './operationTypes';
import {workspaceBindingNotice,workspaceModeDescriptions,workspaceModeLabels} from './workspaceBinding';
import {useWorkspaceBinding} from './useWorkspaceBinding';
import './localOperations.less';

const labels:Record<TWorkspaceBindingMode,string>={new:'Связать папку','new-copy':'Связать как отдельную копию',
    'adopt-legacy':'Подтвердить старую привязку',transfer:'Подтвердить перенос',resume:'Вернуться к папке'};

/** Проверка начинается явным выбором папки; конкретная финальная кнопка подтверждает действие. */
export function WorkspaceBindingWizard({bridge,project,canManage=false,onClose}:{bridge:ReturnType<typeof useBridge>;project:{id:string;name:string};canManage?:boolean;onClose():void}) {
    const state=useWorkspaceBinding({bridge,project,canManage,onClose});
    const folders=bridge.device?.report.folders||[],root=bridge.device?.report.root;
    const notice=workspaceBindingNotice(state.binding);
    const ready=!!state.preparation&&!state.stale&&!state.expired&&!state.failedCommit;
    const checkLabel=state.locked?'Проверяем папку…':state.retryPrepare?'Повторить отправленный запрос':state.request?'Повторить проверку':'Проверить папку';
    return <Modal open title={`Связать папку с проектом «${project.name}»`} onCancel={()=>{if(!state.busy)onClose();}} footer={null} width={640}>
        <Space direction="vertical" size={16} className="local-operation">
            <Typography.Text>Компьютер: <strong>{bridge.device?.name||'Не выбран'}</strong></Typography.Text>
            <Typography.Text>Общая папка: <Typography.Text code className="local-operation__hash">{root||'Не выбрана'}</Typography.Text></Typography.Text>
            {notice&&<Alert type="warning" showIcon message={notice}/>}
            {folders.length>0?<Select aria-label="Локальная папка проекта" style={{width:'100%'}} value={state.folderName} disabled={state.selectionLocked}
                showSearch optionFilterProp="label" placeholder="Выберите папку проекта" onChange={state.chooseFolder}
                options={folders.map(value=>({value,label:value}))}/>:<Alert type="info" showIcon message={root?'В общей папке пока нет папок проектов':'Сначала выберите общую папку проектов'}
                description={root?'Создайте подпапку проекта на выбранном компьютере, затем обновите список.':'Закройте это окно и выберите общую папку через мост в разделе «Проекты».'}
                action={root?<Button loading={bridge.loading} onClick={()=>{void state.refresh();}}>Обновить список</Button>:<Button onClick={onClose}>К выбору общей папки</Button>}/>}
            <Collapse ghost><Collapse.Panel header="Другие действия с папкой" key="advanced">
                <Space direction="vertical" size={8} style={{width:'100%'}}>
                    <Select aria-label="Действие с папкой" style={{width:'100%'}} value={state.mode} disabled={state.selectionLocked}
                        onChange={state.chooseMode} options={Object.entries(workspaceModeLabels).map(([value,label])=>({value,label:value==='new'?'Обычная привязка':label}))}/>
                    <Typography.Text type="secondary">{workspaceModeDescriptions[state.mode]}</Typography.Text>
                    <Typography.Text type="secondary">Эти действия не копируют и не перемещают файлы. Выберите уже подготовленную папку.</Typography.Text>
                </Space>
            </Collapse.Panel></Collapse>
            {state.sourceError&&<Alert type="info" showIcon message={state.sourceError}/>}
            {ready&&state.request&&<>
                {state.request.sourceFolderName&&<Typography.Text>Прежняя папка: <strong>{state.request.sourceFolderName}</strong></Typography.Text>}
                <Alert type="info" showIcon message="Папка и экземпляр проверены"
                    description={state.preparation!.requiresFileVerification?'При подтверждении мост дополнительно сверит файлы. До этого они не считаются проверенными.':'При подтверждении мост повторно проверит папку и сохранит привязку.'}/>
            </>}
            {(state.retryPrepare||state.retryCommit)&&<Alert type="warning" showIcon message="Ответ на отправленный запрос ещё не подтверждён"
                description="Повтор использует исходный ключ и получает результат прежнего запроса, не создавая второе действие."/>}
            <Space wrap>
                {state.retryCommit?<Button type="primary" disabled={!!state.blocker||!!state.otherPending||state.locked} loading={state.busy} onClick={()=>{void state.commit();}}>Проверить отправленную привязку</Button>
                    :ready?<Button type="primary" disabled={!!state.blocker||!!state.otherPending||state.locked} loading={state.busy} onClick={()=>{void state.commit();}}>{labels[state.mode]}</Button>
                        :<Button type="primary" disabled={!!state.blocker||!!state.sourceError||!state.folderName||state.locked||!!state.otherPending}
                            loading={state.locked} onClick={()=>{void state.prepare();}}>{checkLabel}</Button>}
                <Button disabled={state.busy} onClick={onClose}>Закрыть</Button>
            </Space>
            {state.stale&&<Alert type="warning" showIcon message={state.retryCommit
                ?'Компьютер или исходная привязка изменились. Нажмите «Проверить отправленную привязку», чтобы уточнить результат исходного запроса.'
                :state.retryPrepare?'Компьютер или исходная привязка изменились. Выберите актуальную папку или действие в этом окне для новой проверки.'
                :'Компьютер или исходная привязка изменились. Повторите проверку папки.'}/>}
            {state.expired&&!state.retryCommit&&<Alert type="warning" showIcon message="Проверка папки устарела через 15 минут. Повторите её перед привязкой."/>}
            {state.blocker&&<Alert type="warning" showIcon message={state.blocker}
                action={bridge.errors.devices||bridge.errors.jobs||!bridge.devicesReady||!bridge.jobsReady?<Button size="small" loading={bridge.loading} onClick={()=>{void state.refresh();}}>Обновить данные</Button>:undefined}/>}
            {state.otherPending&&<Alert type="info" showIcon message="Сначала дождитесь завершения другого действия с проектом." description={state.otherPending.message}/>}
            {(state.pendingJob||state.job&&!(state.job.kind==='prepare-bind-project'&&state.job.state==='succeeded'))&&<Alert role="status" type={state.job?.state==='failed'?'error':'info'} showIcon message={(state.pendingJob||state.job)!.message}
                action={state.pendingJob?.state==='queued'?<Button size="small" disabled={state.busy||!!state.blocker} loading={state.cancelling===state.pendingJob.id}
                    onClick={()=>{void state.cancel(state.pendingJob!.id);}}>Отменить</Button>:undefined}/>}
            {state.error&&<Alert type="error" role="alert" showIcon message={state.error}/>}
        </Space>
    </Modal>;
}
