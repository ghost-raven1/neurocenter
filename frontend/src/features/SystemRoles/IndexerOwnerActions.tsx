import { Alert, Space } from 'antd';
import { Link } from 'react-router-dom';
import { baseRoutes } from '../../core/baseRoutes';
/** Real snapshot/sync workflows retain their own pinned device/folder selection, confirmation and job owners. */
export function IndexerOwnerActions({ projectId }: { projectId: string | null }): JSX.Element {
    if (!projectId) return <Alert showIcon type="info" message="Выберите проект для работы со снимками и синхронизацией." />;
    const path = baseRoutes.projectDetail.replace(':projectId', encodeURIComponent(projectId));
    return <Alert showIcon type="info" message="Действия с данными подтверждаются отдельно" description={<Space direction="vertical">
        <span>Агент объясняет измерения. Снимок, папку и направление передачи выбирает человек в действующем мастере.</span>
        <Space wrap><Link to={path + '?tab=snapshots'}>Снимки и публикация образа</Link><Link to={path + '?tab=rag'}>Синхронизация и восстановление базы знаний</Link></Space>
    </Space>} />;
}
