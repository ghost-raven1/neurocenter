import {useState} from 'react';
import {Button} from 'antd';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {LearningQuirksImportModal} from './LearningQuirksImportModal';

interface Props {projectId:string;canManage:boolean;enabled?:boolean;onImported?:()=>void}
/** Lazy mounting avoids device traffic until the user opens this explicit collection workflow. */
export function LearningQuirksButton(props:Props):JSX.Element{
    const [open,setOpen]=useState(false);
    const availability=useFeatureAvailability('project_learning_quirks');
    return <><Button onClick={()=>setOpen(true)}>Собрать кварки RAG</Button>{open&&<LearningQuirksImportModal key={props.projectId} {...props} enabled={availability.enabled&&props.enabled!==false} disabledReason={availability.reason} open onClose={()=>setOpen(false)} />}</>;
}
