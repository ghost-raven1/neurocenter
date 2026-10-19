import { Alert, Button, Space, Table, message } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import base from '../../../core/api/base';
import { errorMessage } from '../../../common/utils/errorMessage';
import { formatBytes } from '../../../common/utils/format';

import {requireProjectBackup,type IProjectBackup} from '../features/ProjectBackups/model';
import {useSectionUpdates} from '../../../core/socket/useSectionUpdates';
import {projectReadUnavailable} from '../projectReadError';
import {useAuthRequestOwner} from '../../../features/UserBlock/useAuthRequestOwner';

/** Независимые резервные копии серверной базы знаний выбранного проекта. */
export default function ProjectBackups({projectKey}:{projectKey:string}):JSX.Element {
    const {captureOwner}=useAuthRequestOwner();
    const [items,setItems]=useState<IProjectBackup[]>([]);
    const [loading,setLoading]=useState(false);
    const [creating,setCreating]=useState(false);
    const [unavailable,setUnavailable]=useState(false);
    const [loadError,setLoadError]=useState('');const [createError,setCreateError]=useState('');const [warnings,setWarnings]=useState<string[]>([]);
    const generation=useRef(0);const busy=useRef(false);
    const load=useCallback(()=>{
        const isCurrent=captureOwner();if(!isCurrent()){return;}
        const request=++generation.current;
        setLoading(true); base.get<IProjectBackup[]>(`/api/projects/${encodeURIComponent(projectKey)}/backups`)
            .then(result=>{if(!isCurrent()){return;}if(!Array.isArray(result.data)){throw new Error('Сервер не подтвердил список копий.');}const items=result.data.map(item=>requireProjectBackup(item,projectKey));if(request===generation.current){setItems(items);setUnavailable(false);setLoadError('');}})
            .catch(error=>{if(isCurrent()&&request===generation.current){if(projectReadUnavailable(error)){setItems([]);setUnavailable(true);}setLoadError(errorMessage(error,'Не удалось загрузить резервные копии.'));}})
            .finally(()=>{if(isCurrent()&&request===generation.current){setLoading(false);}});
    },[projectKey,captureOwner]);
    useEffect(()=>{setItems([]);setUnavailable(false);setLoadError('');setCreateError('');setWarnings([]);load();return()=>{generation.current++;};},[load]);
    useSectionUpdates(['projects','maintenance'],load);
    const create=async():Promise<void>=>{
        const isCurrent=captureOwner();
        if(!isCurrent()||busy.current||unavailable){return;}busy.current=true;setCreating(true);setCreateError('');setWarnings([]);
        try { const response=await base.post(`/api/projects/${encodeURIComponent(projectKey)}/backups`);if(!isCurrent()){return;}const saved=requireProjectBackup(response.data,projectKey);setWarnings(saved.warnings||[]);load();message.success('Резервная копия проекта создана'); }
        catch(error) { if(isCurrent()){setCreateError(errorMessage(error,'Не удалось подтвердить резервную копию. Обновите список перед повтором.'));} }
        finally { if(isCurrent()){busy.current=false;setCreating(false);} }
    };
    return <Space direction="vertical" size={20} style={{width:'100%'}}>
        <Alert showIcon type="info" message="Отдельные копии PostgreSQL-базы знаний проекта" description="После подтверждения новой копии сохраняются пять последних дампов. Размер ограничен общим хранилищем; при отказе предыдущие копии остаются доступны. Локальная LanceDB и файлы проекта сюда не входят." />
        <Space wrap><Button type="primary" loading={creating} disabled={unavailable} onClick={()=>void create()}>Создать резервную копию</Button><Button onClick={load} loading={loading}>Обновить</Button></Space>
        {createError&&<Alert showIcon type="error" message="Копия не подтверждена" description={createError} />}
        {!!warnings.length&&<Alert showIcon type="warning" message="Копия создана с предупреждением" description={warnings.join(' ')} />}
        {loadError&&<Alert showIcon type="warning" message={items.length?'Показаны последние полученные копии':'Список копий недоступен'} description={loadError} action={<Button onClick={load}>Повторить</Button>} />}
        <Table rowKey="id" dataSource={items} loading={loading} scroll={{x:560}} locale={{emptyText:loadError?'Не удалось загрузить список':'Резервных копий пока нет'}} columns={[
            {title:'Создана',dataIndex:'createdAt',render:(value:string)=>new Date(value).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'medium'})},
            {title:'Размер',dataIndex:'sizeBytes',render:(value:number)=>formatBytes(value)},
            {title:'Файл',dataIndex:'fileName',ellipsis:true},
            {title:'',render:(_,item)=><Button href={`/api/projects/${encodeURIComponent(projectKey)}/backups/${encodeURIComponent(item.id)}/download`}>Скачать</Button>},
        ]} />
    </Space>;
}
