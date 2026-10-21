import { CopyOutlined, EditOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Empty, Grid, message, Modal, Radio, Space, Spin, Tabs, Tag, Timeline, Typography } from 'antd';
import { Component, FC, lazy, PropsWithChildren, Suspense, useEffect, useState } from 'react';
import bffApi from '../../core/api/bff';
import type { IAiPluginVersion } from '../../core/api/interfaces';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { errorMessage } from '../../common/utils/errorMessage';
import { KindBadge, type IStoreApp } from './AppCard';
import StoreDetailsInstallStatus, { StoreDetailsInstallButton } from './StoreDetailsInstall';
import { formatDetailDate, keepDetailAfterRefreshError, loadStoreDetail, sortSkillHistory, type IStoreInstallStatus, type TStoreDetail } from './storeDetails';
import { StoreBundleContent } from './StoreBundleContent';
import {storeCardRevision,storeCardSource} from './storeCardPresentation';
import './StoreDetailsModal.less';

const { Text, Paragraph } = Typography;
const StoreInstruction = lazy(() => import('./StoreInstruction'));

/** При сбое загрузки форматирования весь текст остаётся доступен без перезагрузки. */
class InstructionPreview extends Component<PropsWithChildren<{ body: string }>, { failed: boolean }> {
    public state = { failed: false };
    public static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
    public render(): JSX.Element | React.ReactNode {
        return this.state.failed ? <>
            <Alert type="warning" showIcon message="Не удалось отформатировать инструкцию. Ниже доступен полный исходник." />
            <pre className="store-details__source" tabIndex={0} aria-label="Исходник инструкции в Markdown">{this.props.body}</pre>
        </> : this.props.children;
    }
}
interface IProps {
    viewApp: IStoreApp | null;
    onClose: () => void;
    /** Передаётся только при наличии права редактирования выбранного инструмента. */
    onEdit?: () => void;
    /** Common catalog action is passed only when the current main admin can manage its head. */
    archiveAction?: React.ReactNode;
    projectName?: string;
    /** Store передаёт действие только для доступного пользователю проекта и компьютера. */
    onInstall?: (version:number) => void;
    installStatus?: IStoreInstallStatus;
    installBusy?: boolean;
    /** Причина отсутствия действия остаётся видна и внутри открытой карточки. */
    installUnavailableReason?: string;
    /** Доступное администратору действие добавляет инструмент в текущий каталог проекта. */
    onAddToProject?: () => void;
    addingToProject?: boolean;
    onChooseProjectFolder?: () => void;
}
interface IDetailState { key: string; value: TStoreDetail | null; error: string | null; }
interface IHistoryState { key: string; value: IAiPluginVersion[] | null; error: string | null; }

/** Полная инструкция, метаданные и действительная история выбранного инструмента. */
const StoreDetailsModal: FC<IProps> = ({ viewApp, onClose, onEdit, archiveAction, projectName, onInstall, installStatus, installBusy, installUnavailableReason, onAddToProject, addingToProject, onChooseProjectFolder }) => {
    const columns = Grid.useBreakpoint().sm ? 2 : 1;
    const identity = viewApp ? `${viewApp.kind}:${viewApp.id}:${viewApp.version}:${viewApp.projectManifest??''}` : '';
    const [state, setState] = useState<IDetailState>({ key: '', value: null, error: null });
    const [reload, setReload] = useState(0);
    const [activeTab, setActiveTab] = useState('content');
    const [source, setSource] = useState(false);
    const [copying, setCopying] = useState(false);
    const [history, setHistory] = useState<IHistoryState>({ key: '', value: null, error: null });
    const [historyReload, setHistoryReload] = useState(0);
    const detail = state.key === identity ? state.value : null;
    const loadError = state.key === identity ? state.error : null;
    useSectionUpdates(['catalog'], () => setReload(value => value + 1), !!viewApp);

    useEffect(() => {
        setActiveTab('content');
        setSource(false);
        setHistory({ key: '', value: null, error: null });
    }, [identity]);

    useEffect(() => {
        let current = true;
        setState(previous => ({ key: identity, value: previous.key === identity ? previous.value : null, error: null }));
        if (viewApp) {
            void loadStoreDetail(bffApi, viewApp).then(value => {
                if (current) { setState({ key: identity, value, error: null }); }
            }).catch(error => {
                if (current) {
                    setState(previous => ({ key: identity, value: previous.key === identity && keepDetailAfterRefreshError(error) ? previous.value : null,
                        error: errorMessage(error, 'Не удалось загрузить инструмент. Проверьте подключение и повторите попытку.') }));
                }
            });
        }
        return () => { current = false; };
    }, [identity, reload]);

    useEffect(() => {
        if (!viewApp || detail?.kind !== 'bundle' || activeTab !== 'history') { return; }
        let current = true;
        setHistory({ key: identity, value: null, error: null });
        void bffApi.listAiPluginVersions(viewApp.id).then(value => {
            if (current) { setHistory({ key: identity, value, error: null }); }
        }).catch(error => {
            if (current) { setHistory({ key: identity, value: null, error: errorMessage(error, 'Не удалось загрузить историю версий.') }); }
        });
        return () => { current = false; };
    }, [identity, detail, activeTab, historyReload]);

    const copy = async (value: string): Promise<void> => {
        setCopying(true);
        try {
            if (!navigator.clipboard?.writeText) { throw new Error('Буфер обмена недоступен. Откройте исходник и скопируйте текст вручную.'); }
            await navigator.clipboard.writeText(value);
            message.success('Скопировано');
        } catch (error) { message.error(errorMessage(error, 'Не удалось скопировать. Выделите текст вручную.')); }
        finally { setCopying(false); }
    };

    const renderContent = (): JSX.Element | null => {
        if (!detail) { return null; }
        if (detail.kind === 'skill') {
            const body = detail.skill.body;
            return <section aria-label="Инструкция скилла">
                <div className="store-details__toolbar">
                    <Radio.Group size="small" value={source ? 'source' : 'read'} onChange={event => setSource(event.target.value === 'source')} aria-label="Режим просмотра инструкции">
                        <Radio.Button value="read">Читать</Radio.Button>
                        <Radio.Button value="source">Исходник</Radio.Button>
                    </Radio.Group>
                    <Button size="small" icon={<CopyOutlined />} loading={copying} disabled={!body.trim()} onClick={() => { void copy(body); }}>Копировать инструкцию</Button>
                </div>
                {!body.trim() ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Инструкция пока не добавлена" />
                    : source ? <pre className="store-details__source" tabIndex={0} aria-label="Исходник инструкции в Markdown">{body}</pre>
                        : <InstructionPreview key={identity} body={body}><Suspense fallback={<div className="store-details__loading" role="status"><Spin tip="Готовим инструкцию…" /></div>}><StoreInstruction key={`${identity}:${detail.skill.meta.version}`} skillKey={`${identity}:${detail.skill.meta.version}`} body={body} resources={detail.skill.resources} /></Suspense></InstructionPreview>}
            </section>;
        }
        return <StoreBundleContent plugin={detail.plugin} copying={copying} onCopy={value => { void copy(value); }} />;
    };

    const renderMetadata = (): JSX.Element | null => {
        if (!detail) { return null; }
        if (detail.kind === 'skill') {
            const { meta, path } = detail.skill;
            return <>
                <Descriptions column={columns} layout="vertical" colon={false} size="small">
                    <Descriptions.Item label="Каталог">{meta.scope === 'project' ? 'Проектный' : 'Общий'}</Descriptions.Item>
                    <Descriptions.Item label="Владелец">{meta.owner || 'Не указан'}</Descriptions.Item>
                    <Descriptions.Item label="Версия">{meta.version}</Descriptions.Item>
                    <Descriptions.Item label="Обновлён">{formatDetailDate(meta.updatedAt)}</Descriptions.Item>
                    <Descriptions.Item label="Путь в каталоге" span={columns}><Text code className="store-details__path">{path}</Text></Descriptions.Item>
                    {meta.projectId && <Descriptions.Item label="Проект" span={columns}>{meta.projectId}</Descriptions.Item>}
                    {meta.specialization && <Descriptions.Item label="Специализация" span={columns}>{meta.specialization}</Descriptions.Item>}
                </Descriptions>
                <div className="store-details__dependencies">
                    <h3>Связанные инструменты</h3>
                    <div><Text strong>MCP</Text><div>{meta.mcp?.length ? meta.mcp.map(name => <Tag key={name}>{name}</Tag>) : <Text type="secondary">Не указаны</Text>}</div></div>
                    <div><Text strong>Плагины</Text><div>{meta.plugins?.length ? meta.plugins.map(name => <Tag key={name}>{name}</Tag>) : <Text type="secondary">Не указаны</Text>}</div></div>
                    <Paragraph type="secondary">Список показывает связи из метаданных скилла. Состояние установки на компьютере здесь не проверяется.</Paragraph>
                </div>
            </>;
        }
        const { plugin } = detail;
        const origin=storeCardSource(plugin.origin),revision=storeCardRevision(plugin.revision);
        return <Descriptions column={columns} layout="vertical" colon={false} size="small">
            <Descriptions.Item label="Идентификатор" span={columns}><Text code className="store-details__path">{plugin.id}</Text></Descriptions.Item>
            <Descriptions.Item label="Редакция каталога">{plugin.version}</Descriptions.Item>
            {revision&&<Descriptions.Item label="Версия поставки">{revision}</Descriptions.Item>}
            <Descriptions.Item label="Совместимость">{plugin.compatibility || 'Не указана'}</Descriptions.Item>
            <Descriptions.Item label="Опубликован">{formatDetailDate(plugin.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="Обновлён">{formatDetailDate(plugin.updatedAt)}</Descriptions.Item>
            <Descriptions.Item label="Источник" span={columns}>{origin?.href?<Typography.Link href={origin.href} target="_blank" rel="noopener noreferrer" className="store-details__path">{origin.label}</Typography.Link>:<Text className="store-details__path">{origin?.label || (plugin.origin?'Публичный источник не определён':'Не указан')}</Text>}</Descriptions.Item>
            {plugin.revision && !revision && <Descriptions.Item label="Ревизия источника" span={columns}><Text code className="store-details__path">{plugin.revision}</Text></Descriptions.Item>}
        </Descriptions>;
    };

    const renderHistory = (): JSX.Element | null => {
        if (!detail) { return null; }
        if (detail.kind === 'skill') {
            const entries = sortSkillHistory(detail.skill.meta.history ?? []);
            return <>
                <Paragraph type="secondary">Журнал изменений скилла. Содержимое прошлых версий недоступно в этом окне.</Paragraph>
                {entries.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="История изменений пока пуста" /> : <Timeline className="store-details__history">
                    {entries.map((entry, index) => <Timeline.Item key={`${entry.version}:${index}`} color={entry.version === detail.skill.meta.version ? 'var(--brand-primary)' : 'gray'}>
                        <Space wrap><Text strong>Версия {entry.version}</Text>{entry.version === detail.skill.meta.version && <Tag color="cyan">Текущая</Tag>}</Space>
                        <div><Text type="secondary">{formatDetailDate(entry.at)} · {entry.author || 'Автор не указан'}</Text></div>
                        <Paragraph>{entry.note || 'Комментарий к версии не добавлен'}</Paragraph>
                    </Timeline.Item>)}
                </Timeline>}
            </>;
        }
        if (history.key !== identity || (!history.value && !history.error)) { return <div className="store-details__loading" role="status"><Spin tip="Загружаем историю версий…" /></div>; }
        if (history.error) { return <Alert type="error" showIcon message={history.error} action={<Button onClick={() => setHistoryReload(value => value + 1)}>Повторить</Button>} />; }
        return !history.value?.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="История версий пока пуста" /> : <Timeline className="store-details__history">
            {[...history.value].sort((left, right) => right.version - left.version).map(entry => <Timeline.Item key={entry.version} color={entry.version === detail.plugin.version ? 'var(--brand-primary)' : 'gray'}>
                <Space wrap><Text strong>Редакция {entry.version}</Text>{entry.version === detail.plugin.version && <Tag color="cyan">Текущая</Tag>}</Space>
                <div><Text type="secondary">{formatDetailDate(entry.createdAt)} · {entry.author || 'Автор не указан'}</Text></div>
                <Paragraph>{entry.note || 'Комментарий к версии не добавлен'}</Paragraph>
            </Timeline.Item>)}
        </Timeline>;
    };

    const version = detail?.kind === 'skill' ? detail.skill.meta.version : detail?.plugin.version ?? viewApp?.version;
    const description = detail?.kind === 'skill' ? detail.skill.meta.description : detail?.plugin.description;
    const tags = detail?.kind === 'skill' ? detail.skill.meta.tags : detail?.plugin.tags;
    const name = detail?.kind === 'skill' ? detail.skill.meta.name : detail?.plugin.name;

    return <Modal
        open={!!viewApp}
        title={viewApp && <div className="store-details__title"><KindBadge kind={viewApp.kind} /><span>{name || viewApp.name}</span></div>}
        className="store-details"
        width={920}
        style={{ top: 24 }}
        onCancel={onClose}
        destroyOnClose
        footer={<div className="store-details__footer">
            <div className="store-details__secondary-actions">{onEdit && <Button icon={<EditOutlined />} onClick={onEdit} disabled={!detail || !!loadError}>Редактировать</Button>}{archiveAction}</div>
            <div className="store-details__primary-actions">
                {onAddToProject && <Button type="primary" loading={addingToProject} disabled={!detail || !!loadError || addingToProject} onClick={onAddToProject}>Добавить в проект</Button>}
                {onChooseProjectFolder && <Button type="primary" onClick={onChooseProjectFolder}>Выбрать папку проекта</Button>}
                <StoreDetailsInstallButton onInstall={onInstall&&version?()=>onInstall(version):undefined} status={installStatus} busy={installBusy} disabled={!detail || !!loadError} />
                <Button type={onInstall || onAddToProject || onChooseProjectFolder ? 'default' : 'primary'} onClick={onClose}>Закрыть</Button>
            </div>
        </div>}
    >
        <StoreDetailsInstallStatus status={installStatus} busy={installBusy} />
        {installUnavailableReason && <Alert type="info" showIcon message={onAddToProject ? 'Добавьте инструмент в проект' : onChooseProjectFolder ? 'Подготовьте папку проекта' : 'Установка пока недоступна'} description={installUnavailableReason} />}
        {loadError && detail && <Alert className="store-details__refresh-error" type="warning" showIcon message="Не удалось обновить данные" description={loadError} action={<Button icon={<ReloadOutlined />} onClick={() => setReload(value => value + 1)}>Повторить</Button>} />}
        {loadError && !detail ? <Alert type="error" showIcon message="Не удалось открыть инструмент" description={loadError} action={<Button icon={<ReloadOutlined />} onClick={() => setReload(value => value + 1)}>Повторить</Button>} />
            : !detail ? <div className="store-details__loading" role="status" aria-live="polite"><Spin tip="Загружаем содержимое…" /></div>
                : <>
                    <div className="store-details__summary">
                        <Space wrap><Tag className="store-details__version">{detail.kind==='skill'?'Версия':'Редакция'} {version}</Tag>{detail.kind==='bundle'&&storeCardRevision(detail.plugin.revision)&&<Tag>Поставка {storeCardRevision(detail.plugin.revision)}</Tag>}{(tags ?? []).map(tag => <Tag key={tag}>{tag}</Tag>)}</Space>
                        <Paragraph className="store-details__description" type={description?.trim() ? undefined : 'secondary'}>{description?.trim() || 'Описание пока не добавлено.'}</Paragraph>
                        {projectName && <Text type="secondary" className="store-details__project">Выбранный проект: {projectName}</Text>}
                    </div>
                    <Tabs activeKey={activeTab} onChange={setActiveTab} destroyInactiveTabPane items={[
                        { key: 'content', label: detail.kind === 'skill' ? 'Инструкция' : 'Содержимое', children: renderContent() },
                        { key: 'metadata', label: 'Данные и связи', children: renderMetadata() },
                        { key: 'history', label: 'Версии', children: renderHistory() },
                    ]} />
                </>}
    </Modal>;
};

export default StoreDetailsModal;
