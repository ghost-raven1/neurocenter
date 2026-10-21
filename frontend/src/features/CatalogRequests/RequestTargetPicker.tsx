import {Alert,Button,Select,Typography} from 'antd';
import {useEffect,useRef,useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {catalogRequestsApi} from './api';
import {requireTargets} from './model';
import type {IRequestAssetType,IRequestTarget} from './types';

interface IProps {
    assetType:IRequestAssetType;projectId?:string|null;value?:string;onChange?:(value:string)=>void;
    initial?:IRequestTarget|null;disabled?:boolean;
}

/** Selection comes from authorized catalog metadata; typed URLs never trigger fetching here. */
export function RequestTargetPicker({assetType,projectId,value,onChange,initial,disabled}:IProps):JSX.Element {
    const {captureOwner}=useAuthRequestOwner();
    const [items,setItems]=useState<IRequestTarget[]>([]),[query,setQuery]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0);
    const sequence=useRef(0);
    useEffect(()=>{
        const owns=captureOwner(),request=++sequence.current,current=()=>owns()&&sequence.current===request;
        setItems([]);setLoading(true);setError('');
        const timer=setTimeout(()=>{void catalogRequestsApi.targets(assetType,projectId,query).then(result=>{
            if(current())setItems(requireTargets(result));
        }).catch(cause=>{if(current())setError(errorMessage(cause,'Не удалось загрузить карточки.'));}).finally(()=>{if(current())setLoading(false);});},query?250:0);
        return()=>{clearTimeout(timer);sequence.current++;};
    },[assetType,projectId,query,retry,captureOwner]);
    const options=[...items];
    if(initial&&initial.type===assetType&&initial.id===value&&!options.some(item=>item.id===initial.id))options.unshift(initial);
    return <div>
        <Select aria-label="Карточка каталога" value={value} onChange={onChange} showSearch filterOption={false} searchValue={query} onSearch={setQuery}
            placeholder="Найдите карточку в доступном каталоге" loading={loading} disabled={disabled||!!error}
            notFoundContent={loading?'Загружаем…':error?'Список недоступен':'Карточки не найдены'}
            options={options.map(item=>({value:item.id,label:`${item.name} · v${item.version}${item.available===false?' · недоступна':item.available===null?' · доступность не проверена':''}`,disabled:item.available!==true}))} />
        <Typography.Text type="secondary">Для поиска введите часть названия. Нужен существующий инструмент того же типа.</Typography.Text>
        {error&&<Alert type="error" showIcon message={error} action={<Button size="small" onClick={()=>setRetry(value=>value+1)}>Повторить список карточек</Button>}/>}
    </div>;
}
