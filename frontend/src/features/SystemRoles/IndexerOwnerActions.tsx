import { Alert, Button, Space, Spin } from 'antd';
import { lazy, Suspense, useState } from 'react';
import { useSelector } from 'react-redux';
import { Link } from 'react-router-dom';
import { baseRoutes } from '../../core/baseRoutes';
import type {RootState} from '../../store';
import { projectRoleLevel } from '../UserBlock/roles';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
const ChatSemanticSearchPanel = lazy(() => import('../ChatSemanticSearch/ChatSemanticSearchPanel').then(value => ({default: value.ChatSemanticSearchPanel})));

/** Data workflows retain their own explicit source, consent and durable job owner. */
export function IndexerOwnerActions({ projectId }: { projectId: string | null }): JSX.Element {
    const [searchOpen, setSearchOpen] = useState(false), {scope} = useAuthRequestOwner();
    const user = useSelector((state:RootState) => state.userBlock.user);
    if (!projectId) return <Alert showIcon type="info" message="Выберите проект для работы со снимками и синхронизацией." />;
    const path = baseRoutes.projectDetail.replace(':projectId', encodeURIComponent(projectId));
    return <><Alert showIcon type="info" message="Действия с данными подтверждаются отдельно" description={<Space direction="vertical">
        <span>Агент объясняет измерения. Снимок, папку и направление передачи выбирает человек в действующем мастере.</span>
        <Space wrap><Link to={path + '?tab=snapshots'}>Снимки и публикация образа</Link><Link to={path + '?tab=rag'}>Синхронизация и восстановление базы знаний</Link>
            <Button onClick={() => setSearchOpen(true)}>Поиск в публичных чатах</Button></Space>
    </Space>} />{searchOpen && <Suspense fallback={<Spin tip="Открываем поиск…" />}><ChatSemanticSearchPanel key={JSON.stringify([scope, projectId])} projectId={projectId} canRun={projectRoleLevel(user, projectId) >= 2} onClose={() => setSearchOpen(false)} /></Suspense>}</>;
}
