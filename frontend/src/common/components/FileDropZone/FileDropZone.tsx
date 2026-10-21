import {Button,Typography} from 'antd';
import {UploadOutlined} from '@ant-design/icons';
import {useEffect,useRef,useState,type DragEvent} from 'react';
import './FileDropZone.less';

interface Props {
    label:string; title:string; hint?:string; buttonText:string; accept?:string; multiple?:boolean;
    disabled?:boolean; busy?:boolean; onFiles:(files:File[])=>void; onReject:(message:string)=>void;
}
const hasFiles=(event:DragEvent<HTMLDivElement>):boolean=>Array.from(event.dataTransfer.types).includes('Files');

/** Picker and drop share one batch; transfer, parsing and validation stay with the feature. */
export function FileDropZone(props:Props) {
    const input=useRef<HTMLInputElement>(null),current=useRef(props),active=useRef(true),depth=useRef(0);
    const [dragging,setDragging]=useState(false);current.current=props;
    const blocked=()=>!active.current||!!current.current.disabled||!!current.current.busy;
    const reset=():void=>{depth.current=0;if(active.current)setDragging(false);};
    useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
    useEffect(()=>{if(props.disabled||props.busy)reset();},[props.disabled,props.busy]);
    const select=(files:File[]):void=>{
        if(blocked()||!files.length)return;
        if(!current.current.multiple&&files.length!==1){current.current.onReject('Выберите один файл за одну загрузку.');return;}
        current.current.onFiles(files);
    };
    const drop=(event:DragEvent<HTMLDivElement>):void=>{
        event.preventDefault();event.stopPropagation();reset();if(blocked())return;
        const items=Array.from(event.dataTransfer.items||[]);
        try{
            if(items.some(item=>item.kind==='file'&&item.webkitGetAsEntry?.()?.isDirectory)){
                current.current.onReject('Перетащите файлы, а папку выберите отдельной кнопкой.');return;
            }
        }catch{current.current.onReject('Не удалось прочитать перетащенные файлы. Выберите их кнопкой.');return;}
        select(Array.from(event.dataTransfer.files));
    };
    return <div role="group" aria-label={props.label} aria-disabled={props.disabled||props.busy||false} aria-busy={!!props.busy}
        className={'file-drop-zone'+(dragging&&!blocked()?' file-drop-zone--active':'')}
        onDragEnter={event=>{event.preventDefault();event.stopPropagation();if(!blocked()&&hasFiles(event)){depth.current++;setDragging(true);}}}
        onDragOver={event=>{event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=!blocked()&&hasFiles(event)?'copy':'none';}}
        onDragLeave={event=>{event.preventDefault();event.stopPropagation();depth.current=Math.max(0,depth.current-1);if(!depth.current)setDragging(false);}}
        onDrop={drop}>
        <UploadOutlined className="file-drop-zone__icon" aria-hidden="true"/>
        <Typography.Text strong>{props.busy?'Обрабатываем файлы…':dragging&&!blocked()?'Отпустите файлы здесь':props.title}</Typography.Text>
        {props.hint&&<Typography.Text type="secondary">{props.hint}</Typography.Text>}
        <Button icon={<UploadOutlined/>} disabled={props.disabled||props.busy} onClick={()=>{if(!blocked())input.current?.click();}}>{props.buttonText}</Button>
        <input ref={input} type="file" hidden aria-label={props.label} accept={props.accept} multiple={props.multiple} disabled={props.disabled||props.busy}
            onChange={event=>{const files=Array.from(event.currentTarget.files||[]);event.currentTarget.value='';select(files);}}/>
    </div>;
}
