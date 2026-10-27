import { FeatureButton, useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import {Alert,Button,Form,Input,Modal,Popconfirm,Space} from 'antd';
import {isAxiosError} from 'axios';
import {useId,useRef,useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {catalogRequestsApi} from './api';
import {requireRequestDetail,requestActionPayload} from './model';
import {createRequestKeys} from './requestKeys';
import {RequestTargetPicker} from './RequestTargetPicker';
import type {IRequestAction,IRequestDetail,IRequestMutation} from './types';

const labels:Record<IRequestAction,string>={start:'Взять в работу',needs_info:'Запросить уточнение',reject:'Отклонить',complete:'Завершить',resubmit:'Отправить на рассмотрение',cancel:'Отменить заявку'};
interface IValues {comment?:string;targetId?:string}
interface IIntent {input:IRequestMutation;revision:number;key:string}
interface IProps {request:IRequestDetail;disabled?:boolean;onSaved:(value:IRequestDetail)=>void;onRefresh:()=>Promise<void>;onBusyChange?:(value:boolean)=>void;onDenied?:()=>void}

/** Review forms retain comments on conflicts; unknown acknowledgements retry an immutable intent. */
export function RequestActions({request,disabled,onSaved,onRefresh,onBusyChange,onDenied}:IProps):JSX.Element {
    const {captureOwner}=useAuthRequestOwner();
    const [form]=Form.useForm<IValues>();
    const formId=useId();
    const [dialog,setDialog]=useState<{action:IRequestAction;revision:number}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[unconfirmed,setUnconfirmed]=useState(false),[conflict,setConflict]=useState(false);
    const lock=useRef(false),keys=useRef(createRequestKeys()),pending=useRef<IIntent>(),lastAction=useRef<IRequestAction>();
    const availability = useFeatureAvailability('catalog_requests');
    const execute=async(input:IRequestMutation,revision=request.revision):Promise<void>=>{
        if (!availability.enabled && input.action !== 'cancel' && !pending.current) return;
        const owns=captureOwner();if(!owns()||lock.current||disabled)return;
        const intent=pending.current??{input,revision,key:keys.current.forIntent(request.id,{input,revision})};
        pending.current=intent;lock.current=true;setBusy(true);onBusyChange?.(true);setError('');setConflict(false);
        try{
            const saved=requireRequestDetail(await catalogRequestsApi.action(request.id,intent.input,intent.revision,intent.key));
            if(!owns())return;pending.current=undefined;setUnconfirmed(false);setDialog(null);form.resetFields();onSaved(saved);
        }catch(cause){if(owns()){
            const status=isAxiosError(cause)?cause.response?.status:undefined;
            if(status===401||status===403){pending.current=undefined;setDialog(null);form.resetFields();if(onDenied)onDenied();else void onRefresh();}
            const unknown=status===undefined||status>=500||status===408;
            if(!unknown)pending.current=undefined;
            setUnconfirmed(unknown);setConflict(status===409);setError(errorMessage(cause,'Не удалось подтвердить действие. Повторите тот же запрос.'));
        }}finally{lock.current=false;if(owns()){setBusy(false);onBusyChange?.(false);}}
    };
    const open=(action:IRequestAction):void=>{
        if(disabled||busy||unconfirmed)return;
        if(lastAction.current!==action){form.resetFields();form.setFieldsValue({targetId:request.target?.available===true?request.target.id:undefined});}
        lastAction.current=action;setError('');setConflict(false);setDialog({action,revision:request.revision});
    };
    const frozen=!!disabled||busy||unconfirmed;
    const submit=(values:IValues):void=>{
        if(!dialog)return;
        try{void execute(requestActionPayload(request,dialog.action,values),dialog.revision);}
        catch(cause){setError(errorMessage(cause,'Проверьте действие с заявкой.'));}
    };
    const failure=<>{error&&<Alert role="alert" type="error" showIcon message={error}/>} {conflict&&<Alert type="warning" showIcon message="Заявка уже изменилась" description="Комментарий сохранён. Проверьте актуальную заявку, затем повторно выберите действие." action={<Button disabled={busy} onClick={()=>{setDialog(null);void onRefresh();}}>Проверить актуальную заявку</Button>}/>}</>;
    return <div className="catalog-requests__actions">
        <Space wrap>
            {request.permissions.canResubmit&&<FeatureButton features={['catalog_requests']} type="primary" disabled={frozen} onClick={()=>{void execute({action:'resubmit'});}}>Отправить на рассмотрение</FeatureButton>}
            {request.permissions.canReview&&request.status==='submitted'&&<FeatureButton features={['catalog_requests']} type="primary" disabled={frozen} onClick={()=>{void execute({action:'start'});}}>Взять в работу</FeatureButton>}
            {request.permissions.canReview&&request.status==='in_progress'&&<FeatureButton features={['catalog_requests']} type="primary" disabled={frozen} onClick={()=>open('complete')}>Завершить</FeatureButton>}
            {(request.permissions.canReview||request.permissions.canCancel)&&<details className="catalog-requests__more"><summary aria-label={'Другие действия с заявкой: '+request.title}>Другие действия</summary><Space wrap className="catalog-requests__more-content">
                {request.permissions.canReview&&request.status!=='needs_info'&&<FeatureButton features={['catalog_requests']} disabled={frozen} onClick={()=>open('needs_info')}>Запросить уточнение</FeatureButton>}
                {request.permissions.canReview&&<FeatureButton features={['catalog_requests']} danger disabled={frozen} onClick={()=>open('reject')}>Отклонить</FeatureButton>}
                {request.permissions.canCancel&&<Popconfirm title="Отменить эту заявку? История сохранится." onConfirm={()=>execute({action:'cancel'})} disabled={frozen} okText="Отменить заявку" cancelText="Оставить"><Button disabled={frozen}>Отменить заявку</Button></Popconfirm>}
            </Space></details>}
        </Space>
        {!dialog&&failure}
        {unconfirmed&&<Alert type="warning" showIcon message="Результат действия пока не подтверждён" description="Поля запроса сохранены. Повтор использует прежний ключ и не повторяет принятое действие." action={<Button disabled={busy} loading={busy} onClick={()=>{if(pending.current)void execute(pending.current.input,pending.current.revision);}}>Повторить действие</Button>}/>}
        <Modal centered bodyStyle={{maxHeight:'calc(100dvh - 180px)',overflowY:'auto'}} open={!!dialog} title={dialog?labels[dialog.action]:'Действие с заявкой'} footer={null} forceRender width={600} closable={!busy} maskClosable={!busy} keyboard={!busy} onCancel={()=>{if(!lock.current)setDialog(null);}}>
            <Form form={form} layout="vertical" name={'catalog-request-action-'+formId} disabled={frozen} onFinish={submit}>
                <Form.Item name="comment" label={dialog?.action==='complete'?'Результат':'Комментарий'} rules={[{required:true,whitespace:true,message:'Опишите результат или причину'},{max:4000,message:'До 4000 символов'}]}><Input.TextArea rows={4} maxLength={4000}/></Form.Item>
                {dialog?.action==='complete'&&request.kind!=='issue'&&<Form.Item name="targetId" label="Карточка результата" rules={[{required:true,message:'Выберите проверенную карточку результата'}]}><RequestTargetPicker assetType={request.assetType} projectId={request.projectId} initial={request.target} disabled={frozen}/></Form.Item>}
                {failure}
                {unconfirmed&&<Alert type="warning" showIcon message="Повторите прежнее действие для проверки результата. Поля до подтверждения заблокированы."/>}
                <Space wrap className="catalog-requests__form-actions"><Button disabled={busy} onClick={()=>setDialog(null)}>Закрыть</Button><FeatureButton features={unconfirmed ? [] : ['catalog_requests']} type="primary" disabled={busy||!!disabled} loading={busy} onClick={()=>{if(unconfirmed&&pending.current){void execute(pending.current.input,pending.current.revision);}else form.submit();}}>{unconfirmed?'Повторить действие':dialog?labels[dialog.action]:'Сохранить'}</FeatureButton></Space>
            </Form>
        </Modal>
    </div>;
}
