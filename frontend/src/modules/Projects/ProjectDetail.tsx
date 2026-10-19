import OperationsQueue from '../Operations/OperationsQueue';
import { Alert, Button, Col, Descriptions, Grid, message, Modal, Result, Row, Space, Spin, Statistic, Tabs, Typography } from "antd";
import { FC, useEffect, useRef } from "react";
import { useSelector } from "react-redux";
import { useAppDispatch } from "../../core/hooks";
import { useHistory, useLocation, useParams } from "react-router-dom";
import StatusTag from "../../common/components/StatusTag";
import { formatDate } from "../../common/utils/format";
import bffApi from "../../core/api/bff";
import type { TProjectState } from "../../core/api/interfaces";
import { baseRoutes } from "../../core/baseRoutes";
import { RootState } from "../../store";
import Store from "../Store/Store";
import { fetchProject } from "./redux/actions";
import { clearSelected } from './redux/reducers';
import ProjectBackups from './components/ProjectBackups';
import RagQuotaPanel from './features/RagQuota/RagQuotaPanel';
import RagTab from './components/RagTab';
import MembersTab from './components/MembersTab';
import { projectRoleLevel, isMainAdminRole } from '../../features/UserBlock/roles';
import { PageHeading } from '../../common/components/PageHeading';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import {projectTabSearch} from './projectNavigation';
import { useAuthRequestOwner } from '../../features/UserBlock/useAuthRequestOwner';
import { errorMessage } from '../../common/utils/errorMessage';
import { ProjectSize } from './features/ProjectSize/ProjectSize';
import './ProjectDetail.less';


const { Paragraph } = Typography;


/** Ключи вкладок детальной страницы проекта — используются для deep-link «?tab=<key>». */
const PROJECT_TAB_KEYS: string[] = ['overview', 'members', 'store', 'rag', 'quotas', 'backups', 'audit'];

/**
 * Экран карточки проекта с вкладками (Обзор, RAG-индекс, Версии, Скиллы, MCP/Плагины, Передачи, Квоты, Аудит).
 *
 * @component
 * @returns JSX-элемент карточки проекта
 */
const ProjectDetail: FC = () => {
    const dispatch = useAppDispatch();
    const history = useHistory();
    const location = useLocation();
    const screens = Grid.useBreakpoint();
    const overviewColumns = screens.sm ? 2 : 1;
    const { projectId } = useParams<{ projectId: string }>();
    const { captureOwner } = useAuthRequestOwner();
    const confirmationRef = useRef<{ destroy(): void }>();
    const viewRef = useRef({ projectId, active: true });
    if (viewRef.current.projectId !== projectId) { viewRef.current = { projectId, active: true }; }
    const view = viewRef.current;
    useEffect(() => {
        view.active = true;
        return () => {
            view.active = false;
            confirmationRef.current?.destroy();
            confirmationRef.current = undefined;
        };
    }, [view, captureOwner]);
    const user=useSelector((state:RootState)=>state.userBlock.user);
    const canUseTab=(key:string):boolean=>(!['quotas','backups'].includes(key)||projectRoleLevel(user,projectId)>=3)&&(key!=='audit'||isMainAdminRole(user?.activeRole));

    /** Активная вкладка — берётся из URL (?tab=) при загрузке, иначе «Обзор». */
    const requestedTab=new URLSearchParams(location.search).get('tab')??'overview';
    const activeTab=PROJECT_TAB_KEYS.includes(requestedTab)&&canUseTab(requestedTab)?requestedTab:'overview';

    /** Смена вкладки: обновляет состояние и deep-link в URL запроса. */
    const handleTabChange = (key: string): void => {
        history.replace(`${location.pathname}${projectTabSearch(location.search, key)}${location.hash}`);
    };

    /** Подставить ?tab=<ключ> в URL при первом открытии страницы без параметра. */
    useEffect(() => {
        if (new URLSearchParams(location.search).get('tab') !== activeTab) {
            history.replace(`${location.pathname}${projectTabSearch(location.search, activeTab)}${location.hash}`);
        }
    }, [ history, location, activeTab ]);

    const { selectedId, selected, selectedLoading, selectedError, authScope } = useSelector((state: RootState) => state.projects);

    useEffect(() => {
        if (projectId) {
            dispatch(fetchProject(projectId));
        }
        return () => { dispatch(clearSelected()); };
    }, [ dispatch, projectId, authScope ]);
    useSectionUpdates(['projects'],()=>{if(projectId){void dispatch(fetchProject(projectId));}});

    const backToList = (
        <Button type="primary" onClick={() => history.push(baseRoutes.projects)}>
            К списку проектов
        </Button>
    );

    if (!projectId) {
        return <Result status="warning" subTitle="Указан неверный ID проекта" extra={backToList} />;
    }

    const retryLoad = (): void => {
        if (captureOwner()() && view.active && viewRef.current === view) { void dispatch(fetchProject(projectId)); }
    };
    const loadError = selectedId === projectId ? selectedError : null;

    if (!selected || (selected.id !== projectId && selected.name !== projectId)) {
        if (loadError) {
            const status = loadError.status === 404 ? '404' : loadError.status === 403 ? '403' : 'error';
            const title = status === '404' ? 'Проект не найден' : status === '403' ? 'Нет доступа к проекту' : 'Не удалось загрузить проект';
            return <Result status={status} title={title} subTitle={loadError.message} extra={
                <Space wrap><Button onClick={retryLoad} loading={selectedLoading}>Повторить</Button>{backToList}</Space>
            } />;
        }
        return (
            <div style={{ padding: 48, textAlign: 'center' }}>
                <Spin size="large" />
            </div>
        );
    }

    const overviewTab = (
        <div>
            <Row gutter={[24, 16]} style={{ marginBottom: 24 }}>
                <Col xs={24} sm={8}>
                    <ProjectSize title="Данные проекта" kind="logical" bytes={selected.logicalBytes} error={selected.logicalSizeError} loading={selectedLoading} onRetry={retryLoad} />
                </Col>
                <Col xs={24} sm={8}>
                    <ProjectSize title="Серверная копия знаний" kind="retained" bytes={selected.retainedBytes} error={selected.retainedSizeError} loading={selectedLoading} onRetry={retryLoad} />
                </Col>
                <Col xs={24} sm={8}>
                    <Statistic title="Активные передачи" value={selected.activeOperations} />
                </Col>
            </Row>
            <Descriptions className="project-detail__overview" column={overviewColumns} layout={screens.sm ? 'horizontal' : 'vertical'} bordered size="small" title="Обзор">
                <Descriptions.Item label="Имя" span={overviewColumns}>{selected.name}</Descriptions.Item>
                <Descriptions.Item label="Идентификатор внешнего ресурса" span={overviewColumns}>{selected.externalResourceId}</Descriptions.Item>
                <Descriptions.Item label="Состояние">{<StatusTag status={selected.state as TProjectState} />}</Descriptions.Item>
                <Descriptions.Item label="Создан">{formatDate(selected.createdAt)}</Descriptions.Item>
                <Descriptions.Item label="Защита базы знаний" span={overviewColumns}>Лимит и расход доступны на вкладке «База знаний».{canUseTab('quotas')?' Изменить лимит можно на вкладке «Квоты».':''}</Descriptions.Item>
            </Descriptions>
        </div>
    );

    const items = [
        { key: 'overview', label: 'Обзор', children: overviewTab },
        { key: 'members', label: 'Сотрудники', children: <MembersTab project={selected} /> },
        { key: 'store', label: 'Каталог', children: <Store presetTarget={ selected.name } embedded /> },
        { key: 'rag', label: 'База знаний', children: <RagTab projectKey={selected.id} /> },
        { key: 'backups', label: 'Резервные копии', children: <ProjectBackups key={selected.id} projectKey={selected.id} /> },
        { key: 'quotas', label: 'Квоты', children: <RagQuotaPanel key={selected.id} projectKey={selected.id} /> },
        { key: 'audit', label: 'История', children: <OperationsQueue projectId={selected.id} /> },
    ].filter(item=>canUseTab(item.key));

    const confirmDeleteProject = (): void => {
        const isOwnerCurrent = captureOwner();
        const isCurrent = (): boolean => isOwnerCurrent() && view.active && viewRef.current === view;
        if (confirmationRef.current || !isCurrent() || projectRoleLevel(user, selected.id) < 3) { return; }
        let deleting = false;
        const confirmation = Modal.confirm({
            title: `Удалить проект «${selected.name}»?`,
            content: 'Действие необратимо: проект будет удалён из каталога.',
            okText: 'Удалить',
            okButtonProps: { danger: true },
            cancelText: 'Отмена',
            afterClose: () => { if (confirmationRef.current === confirmation) { confirmationRef.current = undefined; } },
            onOk: async () => {
                if (deleting || !isCurrent()) { return; }
                deleting = true;
                try {
                    await bffApi.deleteProject(projectId);
                    if (!isCurrent()) { return; }
                    message.success('Проект удалён');
                    history.push(baseRoutes.projects);
                } catch (err) {
                    if (!isCurrent()) { return; }
                    message.error(errorMessage(err, 'Не удалось удалить проект'));
                    throw err; // Отклонённый Promise оставляет подтверждение открытым для повтора.
                } finally { deleting = false; }
            },
        });
        confirmationRef.current = confirmation;
    };

    return (
        <div className="project-detail">
            {loadError && <Alert
                className="project-detail__refresh-error"
                type="warning"
                showIcon
                message="Не удалось обновить проект"
                description={loadError.message}
                action={<Button onClick={retryLoad} loading={selectedLoading}>Повторить</Button>}
            />}
            <Paragraph>
                <Button type="link" onClick={() => history.push(baseRoutes.projects)}>← Все проекты</Button>
            </Paragraph>
            <PageHeading title={selected.name} description="Инструменты, знания и участники проекта." actions={
                projectRoleLevel(user,selected.id)>=3 && <Button danger onClick={confirmDeleteProject}>
                    Удалить проект
                </Button>
            } />
            <Tabs activeKey={activeTab} onChange={handleTabChange} items={items} style={{ marginTop: 8 }} />
        </div>
    );
};

export default ProjectDetail;
