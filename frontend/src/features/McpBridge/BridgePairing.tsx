import {Alert,Modal,Space,Spin,Typography} from 'antd';
import {useEffect,useRef,useState,type FC} from 'react';
import {useHistory,useLocation} from 'react-router-dom';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import {errorMessage} from '../../common/utils/errorMessage';
import {bridgeApi,type IBridgePair} from './api';
import {waitForComputer} from './pairingProgress';

type Phase='checking'|'review'|'approving'|'waiting'|'connected'|'error';

/** Явное подтверждение, ожидание живого моста и переход к выбору папки в одном окне. */
export const BridgePairing:FC<{onConnected:(id:string)=>void}>=({onConnected})=>{
    const location=useLocation();const history=useHistory();
    const role=useSelector((state:RootState)=>state.userBlock.user?.activeRole);
    const code=new URLSearchParams(location.search).get('connect')||'';
    const [info,setInfo]=useState<IBridgePair>();const [phase,setPhase]=useState<Phase>('checking');
    const [error,setError]=useState('');const [attempt,setAttempt]=useState(0);
    const approving=useRef(false);
    useEffect(()=>{
        let current=true;setInfo(undefined);setError('');setPhase('checking');
        if(code){void bridgeApi.pair(code).then(value=>{if(current){setInfo(value);setPhase(value.approved?'waiting':'review');}}).catch(cause=>{if(current){setError(errorMessage(cause,'Не удалось проверить ссылку подключения.'));setPhase('error');}});}
        return ()=>{current=false;};
    },[code]);
    useEffect(()=>{
        if(phase!=='waiting'||!info){return;}
        const controller=new AbortController();setError('');
        void waitForComputer(info.fingerprint,bridgeApi.devices,controller.signal).then(device=>{
            if(!controller.signal.aborted){setPhase('connected');onConnected(device.id);}
        }).catch(cause=>{if(!controller.signal.aborted){setError(errorMessage(cause,'Не удалось дождаться компьютера.'));}});
        return ()=>controller.abort();
    },[phase,info,attempt,onConnected]);
    const busy=phase==='checking'||phase==='approving';
    const close=():void=>{
        if(approving.current){return;}
        const params=new URLSearchParams(location.search);params.delete('connect');
        history.replace(location.pathname+(params.size?'?'+params.toString():''));
    };
    const approve=async():Promise<void>=>{
        if(phase!=='review'||!info||approving.current){return;}
        approving.current=true;
        setPhase('approving');setError('');
        try{await bridgeApi.approve(code);setPhase('waiting');}
        catch(cause){setError(errorMessage(cause,'Не удалось подтвердить компьютер.'));setPhase('error');}
        finally{approving.current=false;}
    };
    const next=():void=>{
        if(phase==='connected'){history.replace('/projects');}
        else if(phase==='error'){history.replace('/start?step=1');}
        else if(phase==='waiting'&&error){setAttempt(value=>value+1);}
        else{void approve();}
    };
    return <Modal open={!!code} title={phase==='connected'?'Компьютер подключён':'Подключение компьютера'}
        onCancel={close} onOk={next} cancelText={phase==='waiting'?'Закрыть':'Отмена'}
        okText={phase==='connected'?'Выбрать папку проектов':phase==='error'?'Вернуться к подключению':phase==='waiting'?(error?'Проверить снова':'Ждём ответ компьютера…'):'Подключить компьютер'}
        okButtonProps={{disabled:busy||(phase==='waiting'&&!error),loading:phase==='approving'}}
        closable={phase!=='approving'} maskClosable={phase!=='approving'} keyboard={phase!=='approving'}>
        {phase==='checking'?<Space role="status"><Spin size="small"/>Проверяем ссылку подключения…</Space>:null}
        {info&&<>
            <Typography.Paragraph><Typography.Text strong>{info.name}</Typography.Text></Typography.Paragraph>
            {['review','approving'].includes(phase)&&<>
                <Typography.Paragraph>Вы начали установку на этом компьютере? Сверьте отпечаток с терминалом и подтвердите доступ. Мост сможет выполнять задания в выбранных вами папках с ролью «{role}».</Typography.Paragraph>
                <Typography.Paragraph type="secondary">Отпечаток: <Typography.Text code style={{overflowWrap:'anywhere'}}>{info.fingerprint}</Typography.Text></Typography.Paragraph>
            </>}
            {phase==='waiting'&&!error&&<Alert type="info" showIcon message="Подтверждено. Дожидаемся ответа компьютера…" description="Мост подключится автоматически. Повторять установку или вводить код не нужно."/>}
            {phase==='connected'&&<Alert type="success" showIcon message="Компьютер на связи" description="Теперь выберите общую папку проектов. После привязки папки инструменты устанавливаются одним нажатием."/>}
        </>}
        {error&&<Alert role="alert" type={phase==='waiting'?'warning':'error'} showIcon message={error}/>}
    </Modal>;
};
