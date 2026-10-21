import {Button,Card,Space,Tag,Typography} from 'antd';
import {formatBytes,formatDate} from '../../common/utils/format';
import {projectSnapshotsApi} from './api';
import {snapshotPending,type ProjectSnapshot} from './types';
const labels:Record<ProjectSnapshot['status'],string>={UPLOADING:'Загрузка с компьютера',VERIFYING:'Проверка снимка',VERIFIED:'Проверен',REJECTED:'Отклонён',DELETING:'Ожидает очистки',DELETED:'Удалён'};
const colors:Record<ProjectSnapshot['status'],string>={UPLOADING:'processing',VERIFYING:'processing',VERIFIED:'success',REJECTED:'error',DELETING:'warning',DELETED:'default'};
export interface SnapshotCardProps {
    snapshot:ProjectSnapshot;projectId:string;blocked:boolean;canWrite:boolean;hasHead:boolean;
    onAction:(action:'activate'|'rollback'|'delete'|'cancel'|'release',snapshot:ProjectSnapshot)=>void;
}
/** Status reflects verified server receipts, never the local OpenCode session. */
export function SnapshotCard({snapshot,projectId,blocked,canWrite,hasHead,onAction}:SnapshotCardProps){
    const verified=snapshot.status==='VERIFIED',removable=!snapshot.isHead&&!snapshot.pinned&&!snapshotPending(snapshot)&&!['DELETED','DELETING'].includes(snapshot.status);
    return <Card size="small" className="project-snapshots__card">
        <Space direction="vertical" size={8} style={{width:'100%'}}>
            <Space wrap><Tag color={colors[snapshot.status]}>{labels[snapshot.status]}</Tag>{snapshot.isHead&&<Tag color="blue">Текущий на сервере</Tag>}{snapshot.pinned&&<Tag>Закреплён профилем</Tag>}</Space>
            <Typography.Text strong>{formatDate(snapshot.createdAt)} · {formatBytes(snapshot.bytes)}</Typography.Text>
            <Typography.Text type="secondary">{snapshot.author}</Typography.Text>
            <Typography.Text code className="project-snapshots__identity">{snapshot.snapshotId}</Typography.Text>
            {snapshot.error&&<Typography.Text type="danger">{snapshot.error}</Typography.Text>}
            {snapshot.manifestSha256&&<Typography.Text type="secondary" className="project-snapshots__identity">SHA256: {snapshot.manifestSha256}</Typography.Text>}
            <Space wrap>
                {verified&&<Button href={projectSnapshotsApi.manifestUrl(projectId,snapshot.snapshotId)} download={`snapshot-${snapshot.snapshotId}.json`}>Опись и подпись</Button>}
                {canWrite&&verified&&!snapshot.isHead&&<Button disabled={blocked} onClick={()=>onAction('activate',snapshot)}>Сделать текущим</Button>}
                {canWrite&&verified&&hasHead&&!snapshot.isHead&&<Button disabled={blocked} onClick={()=>onAction('rollback',snapshot)}>Откатить к снимку</Button>}
                {canWrite&&verified&&<Button disabled={blocked} onClick={()=>onAction('release',snapshot)}>Выпустить профиль</Button>}
                {canWrite&&snapshotPending(snapshot)&&<Button disabled={blocked} onClick={()=>onAction('cancel',snapshot)}>Отменить публикацию</Button>}
                {canWrite&&removable&&<Button danger disabled={blocked} onClick={()=>onAction('delete',snapshot)}>Удалить</Button>}
            </Space>
            {snapshot.status==='DELETING'&&<Typography.Text type="secondary">Удаление запрошено. Физическая очистка выполняется после периода ожидания; до подтверждения очистки байты могут оставаться в хранилище.</Typography.Text>}
            {snapshot.isHead&&<Typography.Text type="secondary">Локальная сессия OpenCode не переключается от смены серверного снимка.</Typography.Text>}
        </Space>
    </Card>;
}
