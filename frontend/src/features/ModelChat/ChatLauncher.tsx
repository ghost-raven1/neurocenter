import {CommentOutlined} from '@ant-design/icons';
import {Button,Modal,Spin,Tooltip} from 'antd';
import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {useSelector} from 'react-redux';
import {useLocation} from 'react-router-dom';
import type {RootState} from '../../store';
import {roleLevel} from '../UserBlock/roles';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {OPEN_CHAT_EVENT,routeChatProject,type IChatLaunch} from './chatNavigation';

const ChatOverlay=lazy(()=>import('./ChatOverlay'));

/** The header and project agents share one lazy overlay and restore their original keyboard trigger. */
export function ChatLauncher():JSX.Element {
    const user=useSelector((state:RootState)=>state.userBlock.user),location=useLocation(),{scope}=useAuthRequestOwner();
    const canUse=!!user&&user.userRoles.includes(user.activeRole)&&roleLevel(user.activeRole)>=1;
    const [opened,setOpened]=useState<{scope:string;launch:IChatLaunch}>();
    const trigger=useRef<HTMLElement|null>(null);
    const launch=(value:IChatLaunch):void=>{if(!canUse)return;trigger.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setOpened({scope,launch:value});};
    useEffect(()=>{
        const requested=(event:Event):void=>{const value=(event as CustomEvent<IChatLaunch>).detail;if(value&&typeof value==='object')launch({...(typeof value.projectId==='string'?{projectId:value.projectId}:{}),group:value.group===true,team:value.team===true});};
        window.addEventListener(OPEN_CHAT_EVENT,requested);return()=>window.removeEventListener(OPEN_CHAT_EVENT,requested);
    },[canUse,scope]);
    const close=():void=>{setOpened(undefined);queueMicrotask(()=>{if(trigger.current?.isConnected)trigger.current.focus({preventScroll:true});});};
    const visible=canUse&&opened?.scope===scope;
    return <>
        <Tooltip title={canUse?'Команда проекта и личные диалоги':'Для чата нужен доступ к проекту'}><span><Button icon={<CommentOutlined/>} aria-label="Открыть чат" aria-haspopup="dialog" aria-expanded={!!visible} disabled={!canUse} onClick={()=>{const projectId=routeChatProject(location.pathname,location.search);launch({projectId,team:!!projectId||roleLevel(user?.activeRole??'')===1});}}>Чат</Button></span></Tooltip>
        {visible&&<Suspense fallback={<Modal open centered width={1280} title="Чат" footer={null} onCancel={close}><Spin tip="Открываем чат…"/></Modal>}><ChatOverlay {...opened.launch} onClose={close}/></Suspense>}
    </>;
}
