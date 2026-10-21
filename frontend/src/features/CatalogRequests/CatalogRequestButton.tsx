import {Button} from 'antd';
import {useState} from 'react';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {RequestFormModal} from './RequestFormModal';
import {RequestDetails} from './RequestDetails';
import type {ICatalogRequest,IRequestAssetType,IRequestProject} from './types';

interface IProps {projects:IRequestProject[];projectId?:string;assetType?:IRequestAssetType;onSaved?:(value:ICatalogRequest)=>void}
export function CatalogRequestButton({onSaved,...props}:IProps):JSX.Element {
    const {scope}=useAuthRequestOwner();
    const [open,setOpen]=useState(false),[mounted,setMounted]=useState(false),[created,setCreated]=useState<string|null>(null);
    return <><Button onClick={()=>{setMounted(true);setOpen(true);}}>Подать заявку</Button>{mounted&&<RequestFormModal key={scope} {...props} open={open} onClose={()=>setOpen(false)} onSaved={value=>{setOpen(false);if(onSaved)onSaved(value);else setCreated(value.id);}}/>}{created&&<RequestDetails key={scope+':'+created} id={created} projects={props.projects} onClose={()=>setCreated(null)} onChanged={()=>undefined}/>}</>;
}
