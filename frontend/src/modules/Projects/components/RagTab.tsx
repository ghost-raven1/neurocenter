import { Alert, Button, Card, Col, Row, Space, Spin, Statistic, Typography } from "antd";
import { FC, useCallback, useEffect, useRef, useState } from "react";
import { formatDate } from "../../../common/utils/format";
import bffApi from "../../../core/api/bff";
import {useSectionUpdates} from '../../../core/socket/useSectionUpdates';
import type { IRagSummary } from "../../../core/api/interfaces";
import {KnowledgeSync} from '../../../features/McpBridge/KnowledgeSync';
import {useSelector} from 'react-redux';
import type {RootState} from '../../../store';
import {projectRoleLevel} from '../../../features/UserBlock/roles';
import {errorMessage} from '../../../common/utils/errorMessage';
import {RagQuotaMeter} from '../features/RagQuota/RagQuotaMeter';
import {projectRagCatalogUrl,projectRagSetupUrl} from '../projectNavigation';
import {ragSummaryState} from './ragSummaryState';
import {projectReadUnavailable} from '../projectReadError';
import { ProjectEmbedding } from '../../../features/ProjectEmbedding/ProjectEmbedding';
import {useAuthRequestOwner} from '../../../features/UserBlock/useAuthRequestOwner';
import {ragUiPreferenceKey,type IRagUiPreference} from '../../../features/McpBridge/ragUi/ragUiPreference';
import './RagTab.less';
const { Paragraph, Text } = Typography;

/** Вкладка проекта вынесена в самостоятельный компонент. */
const RagTab: FC<{ projectKey: string }> = ({ projectKey }) => {
    const [ summary, setSummary ] = useState<IRagSummary | null>(null);
    const [ loading, setLoading ] = useState(true);
    const [error,setError]=useState('');const generation=useRef(0);
    const user=useSelector((state:RootState)=>state.userBlock.user);
    const canWrite = projectRoleLevel(user, projectKey) >= 2;
    const {scope:owner,captureOwner}=useAuthRequestOwner();
    const scope=JSON.stringify([owner,projectKey]),currentScope=useRef({scope,epoch:0});
    if(currentScope.current.scope!==scope)currentScope.current={scope,epoch:currentScope.current.epoch+1};
    const epoch=currentScope.current.epoch;
    const [launcher,setLauncher]=useState<{scope:string;preferred?:IRagUiPreference}>({scope});
    if(launcher.scope!==scope)setLauncher({scope});
    const preferRagUi=useCallback((preferred:IRagUiPreference)=>{
        if(captureOwner()()&&currentScope.current.scope===scope&&currentScope.current.epoch===epoch&&preferred.owner===owner&&preferred.request.projectId===projectKey)
            setLauncher(previous=>previous.scope===scope&&previous.preferred&&ragUiPreferenceKey(previous.preferred)===ragUiPreferenceKey(preferred)?previous:{scope,preferred});
    },[captureOwner,scope,epoch,owner,projectKey]);
    const preferred=launcher.scope===scope?launcher.preferred:undefined;

    const load = useCallback(() => {
        const request=++generation.current;
        setLoading(true);
        bffApi.getRagSummary(projectKey)
            .then(value=>{if(request===generation.current){setSummary(value);setError('');}})
            .catch(failure=>{if(request===generation.current){if(projectReadUnavailable(failure)){setSummary(null);}setError(errorMessage(failure,'Не удалось загрузить базу знаний.'));}})
            .finally(() => {if(request===generation.current){setLoading(false);}});
    }, [ projectKey ]);
    useSectionUpdates(['knowledge'],load);

    useEffect(() => {
        setSummary(null);setError('');load();return()=>{generation.current++;};
    }, [ load ]);


    const serverState = summary ? ragSummaryState(summary) : undefined;

    return (
        <div className="project-rag">
            <Row className="project-rag__header" justify="space-between" align="middle" gutter={[ 8, 8 ]}>
                <Col>
                    <Text><b>Проект:</b> {projectKey}</Text>
                </Col>
                <Col>
                    <Button type="link" size="small" onClick={load} loading={loading} style={{ padding: 0 }}>Обновить</Button>
                </Col>
            </Row>

            {error&&<Alert type="warning" showIcon message={summary?'Не удалось обновить сведения — показаны последние данные':'База знаний временно недоступна'} description={error} action={<Button onClick={load} loading={loading}>Повторить</Button>} />}
            <ProjectEmbedding projectId={projectKey} indexProfile={summary?.indexProfile} serverHasData={!!summary?.rowCount} onPreferRagUi={preferRagUi} />
            <Card size="small" title="Подготовка локальных знаний" className="project-rag__setup">
                <Paragraph>Установите OpenCodeRAG в связанную папку проекта и подключите модель выше. Выберите сервер и компьютер: Нейроцентр перестроит локальный индекс и синхронизирует его с сервером одним действием.</Paragraph>
                {canWrite ? <Space wrap>
                    <Button type="primary" href={projectRagCatalogUrl(projectKey)}>Установить OpenCodeRAG</Button>
                    <Button href={projectRagSetupUrl(projectKey)}>Настройка модели и индекса</Button>
                </Space> : <Text type="secondary">Попросите разработчика или администратора проекта подготовить локальный индекс.</Text>}
                <Paragraph type="secondary" className="project-rag__help">Прежний локальный индекс работает до проверки нового. Компьютер не в сети — действие дождётся моста в очереди. После завершения перезапустите OpenCode, чтобы открытая сессия использовала новое подключение. Установка файлов и диагностика запуска сами по себе не подтверждают готовность индекса.</Paragraph>
            </Card>
            <Spin spinning={loading}>
                {summary ? (
                    <div className="project-rag__content">
                        <Row className="project-rag__stats" gutter={[ 12, 12 ]}>
                            <Col xs={ 12 } md={ 6 }>
                                <Card size="small" className="project-rag__stat">
                                    <Statistic
                                        title="Фрагментов"
                                        value={ summary.rowCount }
                                        valueStyle={{ fontSize: 24, color: serverState?.verified ? '#1677ff' : '#64748b' }}
                                    />
                                </Card>
                            </Col>
                            <Col xs={ 12 } md={ 6 }>
                                <Card size="small" className="project-rag__stat">
                                    <Statistic title="Размерность" value={ summary.dimension } valueStyle={{ fontSize: 24 }} />
                                </Card>
                            </Col>
                            <Col xs={ 12 } md={ 6 }>
                                <Card size="small" className="project-rag__stat">
                                    <Statistic
                                        title="Серверная копия"
                                        value={serverState?.title}
                                        valueStyle={{
                                            fontSize: 14,
                                            color: serverState?.verified ? '#1677ff' : '#faad14',
                                        }}
                                    />
                                </Card>
                            </Col>
                            <Col xs={ 12 } md={ 6 }>
                                <Card size="small" className="project-rag__stat">
                                    <Statistic
                                        title="Последняя синхронизация"
                                        value={ summary.lastSyncedAt ? formatDate(summary.lastSyncedAt) : '—' }
                                        valueStyle={{ fontSize: 14 }}
                                    />
                                </Card>
                            </Col>
                        </Row>

                        {summary.quota&&<RagQuotaMeter value={summary.quota} projectKey={projectKey} canEdit={projectRoleLevel(user,projectKey)>=3} />}

                    </div>
                ) : (
                    null
                )}
            </Spin>
            <Card size="small" title="Локальная база знаний через мост" className="project-rag__sync">
                <KnowledgeSync projectId={projectKey} canWrite={canWrite} serverReady={serverState?.verified} connection preferred={preferred}/>
                <Paragraph type="secondary" className="project-rag__help">Отправьте локальный индекс, чтобы знания о проекте были доступны команде. Скачивание заменяет локальный индекс серверной копией. Перед восстановлением закройте OpenCode.</Paragraph>
            </Card>
        </div>
    );
};

export default RagTab;
