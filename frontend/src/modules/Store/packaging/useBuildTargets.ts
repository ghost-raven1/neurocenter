import {useEffect,useMemo,useRef,useState} from 'react';
import type {PackagingKind,ToolBuildRequest} from './types';

/** A local choice belongs to this source and owner; a saved request always wins. */
export function useBuildTargets(scope:string,projectId:string|undefined,captureOwner:()=>()=>boolean,source:object,kind:PackagingKind,editable:boolean,draft?:ToolBuildRequest){
    const context=useMemo(()=>({}),[scope,projectId,captureOwner,source,kind]);
    const [selection,setSelection]=useState<{context:object;value?:string[]}>();
    const current=useRef({context,editable});current.current={context,editable};
    useEffect(()=>{if(draft)setSelection({context,value:draft.targets?[...draft.targets]:undefined});},[context,draft]);
    const value=draft?draft.targets:selection?.context===context?selection.value:undefined;
    return {value,choose:(next?:string[])=>{
        if(current.current.context!==context||!current.current.editable||!captureOwner()())return;
        setSelection({context,value:next?[...next]:undefined});
    }};
}
