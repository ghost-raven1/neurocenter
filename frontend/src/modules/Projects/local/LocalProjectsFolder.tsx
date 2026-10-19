import { FolderOpenOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Typography } from 'antd';
import { useEffect, type FC } from 'react';
import type { IProjectSummary } from '../../../core/api/interfaces';
import { BridgeConnection } from '../../../features/McpBridge/BridgeConnection';
import { WorkspaceBindingWizard } from '../../../features/McpBridge/WorkspaceBindingWizard';
import { useBridge } from '../../../features/McpBridge/useBridge';
import { useLocalJob } from '../../../features/McpBridge/useLocalJob';
import { bridgeApi } from '../../../features/McpBridge/api';
import { isPending } from '../../../features/McpBridge/installationHelpers';
import { bridgeOperationBlocker } from '../../../features/McpBridge/readiness';
import { formatDate } from '../../../common/utils/format';
import './LocalProjectsFolder.less';

interface IProps {
    project: IProjectSummary | null;
    canManage?: boolean;
    onClose: () => void;
    onBindings: (bindings: Record<string, { folderName: string }>) => void;
}
/** Общая папка выбирается native-диалогом; экземпляры подтверждаются отдельным мастером. */
export const LocalProjectsFolder: FC<IProps> = ({ project, canManage = false, onClose, onBindings }) => {
    const bridge = useBridge();
    const operation = useLocalJob(bridge);
    const {device,jobs} = bridge;
    const blocker = bridgeOperationBlocker(device) || (!bridge.devicesReady || !bridge.jobsReady ? 'Дождитесь подключения и загрузки очереди.' : '');
    const pending = jobs.find(job => job.deviceId === device?.id && ['choose-root','bind-project','prepare-bind-project'].includes(job.kind) && isPending(job));
    const latest = pending || operation.job || jobs.find(job => job.deviceId === device?.id && job.kind === 'choose-root');
    useEffect(() => {
        onBindings(Object.fromEntries((device?.report.bindings || []).filter(item => item.valid !== false).map(item => [item.projectId,{folderName:item.folderName}])));
    }, [device?.id,JSON.stringify(device?.report.bindings)]);
    return <>
        <Card className="local-projects-folder" title="Папка проектов на моём компьютере" style={{marginBottom:20}}>
            <BridgeConnection bridge={bridge} />
            <Typography.Paragraph style={{marginTop:12}}>У каждого участника своя общая папка. Свяжите её подкаталоги с серверными проектами — названия могут отличаться.</Typography.Paragraph>
            <Button icon={<FolderOpenOutlined />} disabled={!!blocker || operation.busy || !!pending} title={blocker || undefined}
                loading={operation.busy} onClick={() => {
                    if (bridge.device && !blocker && !pending) { void operation.submit({kind:'choose-root',deviceId:bridge.device.id}); }
                }}>{device?.report.root ? 'Выбрать другую папку' : 'Выбрать папку через мост'}</Button>
            {latest && <Alert style={{marginTop:12}} role="status" showIcon type={latest.state === 'failed' ? 'error' : latest.state === 'succeeded' ? 'success' : 'info'}
                message={isPending(latest) ? latest.message : 'Последний выбор папки'}
                description={!isPending(latest) ? <><time dateTime={latest.updatedAt}>{formatDate(latest.updatedAt)}</time><div>{latest.message}</div></>
                    : latest.state === 'running' && latest.kind === 'choose-root' ? 'Завершите выбор папки в системном окне на выбранном компьютере.' : undefined}
                action={latest.state === 'queued' ? <Button size="small" onClick={() => { void bridgeApi.cancel(latest.id).then(() => bridge.reload()).catch(() => operation.setError('Не удалось отменить задание.')); }}>Отменить</Button> : undefined} />}
            {operation.error && <Alert style={{marginTop:12}} type="error" role="alert" showIcon message={operation.error} />}
        </Card>
        {project && <WorkspaceBindingWizard key={project.id+':'+device?.id} bridge={bridge} project={project} canManage={canManage} onClose={onClose} />}
    </>;
};
