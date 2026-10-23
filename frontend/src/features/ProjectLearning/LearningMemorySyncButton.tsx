import {Button} from 'antd';
import {useState} from 'react';
import {LearningMemorySyncModal} from './LearningMemorySyncModal';
/** Opening the workflow remains possible with the business flag OFF so cleanup and history stay reachable. */
export function LearningMemorySyncButton({projectId,canManage}:{projectId:string;canManage:boolean}):JSX.Element{
 const [open,setOpen]=useState(false);
 return <><Button onClick={()=>setOpen(true)}>Знания в MCP Memory</Button>{open&&<LearningMemorySyncModal key={projectId} projectId={projectId} canManage={canManage} onClose={()=>setOpen(false)}/>}</>;
}
