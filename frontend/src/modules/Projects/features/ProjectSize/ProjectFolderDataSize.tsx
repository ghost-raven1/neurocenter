import {useEffect,useState} from 'react';
import type {IProjectSummary} from '../../../../core/api/interfaces';
import type {useBridge} from '../../../../features/McpBridge/useBridge';
import {ProjectSize} from './ProjectSize';
import {projectDataSize} from './localProjectDataSize';

interface IProps {
    project:Pick<IProjectSummary,'id'|'logicalBytes'|'logicalSizeError'>;
    bridge:Pick<ReturnType<typeof useBridge>,'device'|'devices'|'devicesReady'|'loading'>;
    canRead:boolean;
    canBind:boolean;
    showSetupAction?:boolean;
    title?:string;
    loading:boolean;
    onRetry:()=>void;
}

/** Both project entry points show the same selected computer and preserve the server-only fallback. */
export function ProjectFolderDataSize({project,bridge,canRead,canBind,showSetupAction=true,title,loading,onRetry}:IProps):JSX.Element {
    const [,expire] = useState(0);
    const view=projectDataSize({projectId:project.id,serverBytes:project.logicalBytes,serverError:project.logicalSizeError,
        device:bridge.device,devices:bridge.devices,devicesReady:bridge.devicesReady,loading:bridge.loading,canRead,canBind});
    useEffect(()=>{
        if(view.expiresAt===undefined) return;
        const timer=setTimeout(()=>expire(value=>value+1),Math.max(0,view.expiresAt-Date.now()));
        return ()=>clearTimeout(timer);
    },[view.expiresAt,project.id,bridge.device?.id,canRead]);
    return <ProjectSize kind="logical" title={title} {...view} action={showSetupAction?view.action:undefined} loading={loading||bridge.loading} onRetry={onRetry}/>;
}
