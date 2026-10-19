import { Alert, Button, Checkbox, Form, Input, Modal, Space, Spin, Tabs, Tag, Typography, message } from 'antd';
import { FC, useEffect, useRef, useState } from 'react';

import bffApi from '../../core/api/bff';
import type { IAiPlugin, ISkillFile, ISkillMutationReceipt } from '../../core/api/interfaces';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import type { IStoreApp } from './AppCard';
import { editMcpConfig, editTags, pluginEditPayload, skillEditPayload, storeEditFailure, storeEditValuesChanged } from './storeEditHelpers';
import type { IStoreEditFailure, IStoreEditValues } from './storeEditHelpers';
import { SkillResources } from './publication/SkillResourceEditor';
import { checkSkillResources } from './publication/skillResourceFiles';
import { DependencyPinsEditor } from './publication/DependencyPinsEditor';
import { checkDependencyPins } from './publication/dependencyPins';
import { useAuthRequestOwner } from '../../features/UserBlock/useAuthRequestOwner';
import { notifySkillMutation } from '../Skills/skillMutationFeedback';
import './StoreEditModal.less';

interface IProps { editApp: IStoreApp | null; onClose: () => void; onSaved: () => void; }
type TLoadedEntry = { kind: 'skill'; skill: ISkillFile } | { kind: 'mcp' | 'plugin'; plugin: IAiPlugin };
const EMPTY: IStoreEditValues = { name: '', description: '', tags: '', body: '', config: '', dependencies: [], clearLegacyRequirements: false };

/** Загружает актуальную версию один раз при открытии и сохраняет пользовательский черновик при ошибке. */
const StoreEditModal: FC<IProps> = ({ editApp, onClose, onSaved }) => {
    const { captureOwner } = useAuthRequestOwner();
    const [form] = Form.useForm<IStoreEditValues>();
    const [loaded, setLoaded] = useState<TLoadedEntry | null>(null);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [resourcesBusy, setResourcesBusy] = useState(false);
    const [dependenciesBusy, setDependenciesBusy] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [failure, setFailure] = useState<IStoreEditFailure | null>(null);
    const [reloadCount, setReloadCount] = useState(0);
    const [previousDraft, setPreviousDraft] = useState<IStoreEditValues | null>(null);
    const [showPrevious, setShowPrevious] = useState(false);
    const [activeTab, setActiveTab] = useState('card');
    const [serverVersion, setServerVersion] = useState<number | null>(null);
    const sourceRef = useRef(editApp);
    const initialValuesRef = useRef<IStoreEditValues>(EMPTY);
    const submittingRef = useRef(false);
    const comparisonRequestRef = useRef(0);
    const openedKey = editApp ? editApp.kind + ':' + editApp.id : '';
    const openedKeyRef = useRef(openedKey);
    sourceRef.current = editApp;
    openedKeyRef.current = openedKey;

    useEffect(() => {
        setPreviousDraft(null);
        setShowPrevious(false);
        setActiveTab('card');
    }, [openedKey]);

    useEffect(() => {
        const app = sourceRef.current;
        let cancelled = false;
        const isOwnerCurrent = captureOwner();
        setLoaded(null);
        setResourcesBusy(false);
        setDependenciesBusy(false);
        setServerVersion(null);
        comparisonRequestRef.current += 1;
        setFailure(null);
        setDirty(false);
        if (!app) { return; }
        form.resetFields();
        setLoading(true);
        const read = async (): Promise<void> => {
            try {
                let entry: TLoadedEntry;
                let values: IStoreEditValues;
                if (app.kind === 'skill') {
                    if (!app.path) { throw new Error('У скилла отсутствует путь в каталоге. Обновите страницу магазина.'); }
                    const skill = await bffApi.getSkill(app.path);
                    entry = { kind: 'skill', skill };
                    values = { ...EMPTY, name: skill.meta.name, description: skill.meta.description ?? '', tags: skill.meta.tags.join(', '), body: skill.body, resources: skill.resources ?? [], dependencies: skill.meta.dependencies ?? [] };
                } else {
                    const plugin = await bffApi.getAiPlugin(app.id);
                    entry = { kind: plugin.kind, plugin };
                    values = { ...EMPTY, name: plugin.name, description: plugin.description, tags: plugin.tags.join(', '), config: JSON.stringify(plugin.config ?? {}, null, 2), dependencies: plugin.dependencies ?? [] };
                }
                if (cancelled || !isOwnerCurrent()) { return; }
                initialValuesRef.current = values;
                form.setFieldsValue(values);
                setLoaded(entry);
            } catch (error: unknown) {
                if (!cancelled && isOwnerCurrent()) { setFailure(storeEditFailure(error, 'Не удалось загрузить инструмент. Проверьте соединение и попробуйте снова.')); }
            } finally {
                if (!cancelled && isOwnerCurrent()) { setLoading(false); }
            }
        };
        void read();
        return () => { cancelled = true; };
    }, [openedKey, reloadCount, form, captureOwner]);

    const save = async (values: IStoreEditValues): Promise<void> => {
        if (!loaded || submittingRef.current || resourcesBusy || dependenciesBusy || !dirty) { return; }
        const isOwnerCurrent = captureOwner();
        if (!isOwnerCurrent()) { return; }
        submittingRef.current = true;
        setBusy(true);
        setFailure(null);
        const savingKey = openedKey;
        try {
            let skillResult: ISkillMutationReceipt | undefined;
            if (loaded.kind === 'skill') {
                checkSkillResources(values.resources ?? []);
                skillResult = await bffApi.updateSkill(loaded.skill.path, skillEditPayload(loaded.skill, values));
            } else {
                await bffApi.updateAiPlugin(loaded.plugin.id, pluginEditPayload(loaded.plugin, values));
            }
            if (!isOwnerCurrent() || openedKeyRef.current !== savingKey) { return; }
            if (skillResult) { notifySkillMutation(skillResult, 'Изменения сохранены'); }
            else { message.success('Изменения сохранены'); }
            onSaved();
            onClose();
        } catch (error: unknown) {
            if (isOwnerCurrent() && openedKeyRef.current === savingKey) { setFailure(storeEditFailure(error, 'Не удалось сохранить: нет связи с сервером. Правки остались в форме — попробуйте ещё раз.')); }
        } finally {
            submittingRef.current = false;
            if (isOwnerCurrent()) { setBusy(false); }
        }
    };

    const copyDraft = async (values: IStoreEditValues): Promise<void> => {
        const isCurrent = captureOwner();
        if (!isCurrent()) { return; }
        try { await navigator.clipboard.writeText(JSON.stringify(values, null, 2)); if (isCurrent()) { message.success('Черновик скопирован'); } }
        catch { if (isCurrent()) { message.warning('Браузер не разрешил копирование. Выделите и скопируйте текст вручную.'); } }
    };

    const refreshAfterConflict = (): void => {
        setPreviousDraft(form.getFieldsValue(true));
        setShowPrevious(false);
        setReloadCount(count => count + 1);
    };

    useSectionUpdates(['catalog'], () => {
        if (!editApp || !loaded || submittingRef.current) { return; }
        const isOwnerCurrent = captureOwner();
        const key = openedKey;
        const request = ++comparisonRequestRef.current;
        const original = loaded.kind === 'skill' ? loaded.skill.meta.version : loaded.plugin.version;
        const current = loaded.kind === 'skill'
            ? bffApi.getSkill(loaded.skill.path).then(skill => skill.meta.version)
            : bffApi.getAiPlugin(loaded.plugin.id).then(plugin => plugin.version);
        void current.then(version => {
            if (isOwnerCurrent() && request === comparisonRequestRef.current && openedKeyRef.current === key && !submittingRef.current) { setServerVersion(version === original ? null : version); }
        }).catch(() => { /* Сохранение дополнительно проверяет доступность и исходную версию на сервере. */ });
    }, Boolean(editApp && loaded && !busy && !loading));

    const version = loaded?.kind === 'skill' ? loaded.skill.meta.version : loaded?.plugin.version;
    const isSkill = loaded?.kind === 'skill' || editApp?.kind === 'skill';
    const requiredDescription = !isSkill || Boolean(editApp?.path?.startsWith('common/'));
    const formId = 'store-edit-form';
    const reading = resourcesBusy || dependenciesBusy;
    const legacy = loaded?.kind === 'skill' ? [...loaded.skill.meta.mcp, ...loaded.skill.meta.plugins] : [];
    return (
        <Modal
            open={Boolean(editApp)} title={editApp ? 'Редактировать — ' + editApp.name : ''}
            width={860} className="store-edit-modal" destroyOnClose maskClosable={false}
            closable={!busy && !reading} keyboard={!busy && !reading} onCancel={() => { if (!submittingRef.current && !reading) { onClose(); } }}
            footer={<div className="store-edit-modal__footer">
                <Typography.Text type="secondary">{busy ? 'Сохраняем изменения…' : dirty ? 'Есть несохранённые изменения' : 'Изменения появятся после сохранения'}</Typography.Text>
                <Space><Button disabled={busy || reading} onClick={() => { if (!submittingRef.current && !reading) { onClose(); } }}>Отмена</Button><Button type="primary" form={formId} htmlType="submit" loading={busy} disabled={!loaded || loading || !dirty || reading}>Сохранить изменения</Button></Space>
            </div>}
        >
            {editApp && <>
                <div className="store-edit-modal__context"><Typography.Text type="secondary">{isSkill ? 'Скилл' : editApp.kind === 'mcp' ? 'MCP' : 'Плагин'}</Typography.Text>{version !== undefined && <Tag>Версия {version}</Tag>}<Typography.Text code className="store-edit-modal__identifier">{editApp.path ?? editApp.id}</Typography.Text></div>
                {serverVersion !== null && <Alert type="warning" showIcon message={`Карточка изменена на сервере: версия ${serverVersion}`} description={<><div>Ваши правки и исходная версия сохранены. Сравните их с актуальной копией перед отправкой.</div>{failure?.status !== 409 && <Button className="store-edit-modal__error-actions" onClick={refreshAfterConflict}>Загрузить актуальную версию</Button>}</>} />}
                {failure && <Alert showIcon type="error" role="alert" message={loaded ? 'Изменения не сохранены' : 'Не удалось открыть инструмент'} description={<>
                    <div>{failure.message}</div>
                    <Space wrap className="store-edit-modal__error-actions">
                        {!loaded && <Button onClick={() => setReloadCount(count => count + 1)}>Повторить загрузку</Button>}
                        {loaded && <Button onClick={() => void copyDraft(form.getFieldsValue(true))}>Скопировать правки</Button>}
                        {loaded && failure.status === 409 && <Button onClick={refreshAfterConflict}>Загрузить актуальную версию</Button>}
                    </Space>
                </>} />}
                {previousDraft && <Alert showIcon type="info" message="Предыдущий черновик сохранён в этом окне" description={<>
                    <div>Ниже открыта актуальная версия. Сравните её со своими правками и перенесите нужные изменения.</div>
                    <Space wrap className="store-edit-modal__error-actions"><Button size="small" onClick={() => setShowPrevious(value => !value)}>{showPrevious ? 'Скрыть черновик' : 'Показать черновик'}</Button><Button size="small" onClick={() => void copyDraft(previousDraft)}>Скопировать черновик</Button></Space>
                    {showPrevious && <Input.TextArea aria-label="Предыдущий черновик в JSON" value={JSON.stringify(previousDraft, null, 2)} readOnly autoSize={{ minRows: 5, maxRows: 12 }} className="store-edit-modal__code" />}
                </>} />}
                <Spin spinning={loading} tip="Загружаем актуальную версию…">
                    <Form<IStoreEditValues>
                        id={formId} name="store-edit" form={form} layout="vertical" disabled={busy || reading || !loaded} initialValues={EMPTY}
                        style={!loading && !loaded ? { display: 'none' } : undefined}
                        onFinish={values => void save(values)}
                        onFinishFailed={({ errorFields }) => { const field = errorFields[0]?.name[0]; setActiveTab(field === 'dependencies' ? 'dependencies' : field === 'body' || field === 'resources' ? 'body' : field === 'config' ? 'config' : 'card'); }}
                        onValuesChange={(_, values: IStoreEditValues) => setDirty(storeEditValuesChanged(initialValuesRef.current, values))}
                    >
                        <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
                            { key: 'card', label: 'Карточка', forceRender: true, children: <>
                                <Form.Item label="Название" name="name" rules={isSkill ? [{ required: true, whitespace: true, message: 'Укажите название скилла' }, { max: 128, message: 'До 128 символов' }, { pattern: /^[^\x00-\x1f\x7f]+$/, message: 'Название не должно содержать управляющие символы' }] : undefined} extra={isSkill ? 'Название можно менять, идентификатор и путь скилла сохранятся.' : 'Идентификатор опубликованного инструмента сохраняется.'}>
                                    <Input disabled={!isSkill || busy || !loaded} maxLength={128} autoComplete="off" />
                                </Form.Item>
                                <Form.Item label="Описание" name="description" rules={[{ required: requiredDescription, whitespace: requiredDescription, message: 'Добавьте краткое описание инструмента' }, { max: isSkill ? 1024 : 2000, message: 'До ' + (isSkill ? 1024 : 2000) + ' символов' }]} extra="Кратко объясните, какую задачу решает инструмент и когда его использовать.">
                                    <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} maxLength={isSkill ? 1024 : 2000} showCount />
                                </Form.Item>
                                <Form.Item label="Теги" name="tags" extra="Через запятую, до 20 тегов. Например: RAG, мониторинг, индексация." rules={[{ validator: (_, value: string) => { try { editTags(value ?? '', isSkill ? 128 : 40); return Promise.resolve(); } catch (error: unknown) { return Promise.reject(error); } } }]}>
                                    <Input placeholder="RAG, мониторинг, индексация" autoComplete="off" />
                                </Form.Item>
                            </> },
                            ...(isSkill ? [{ key: 'body', label: 'Инструкция', forceRender: true, children: <>
                                <Alert type="info" showIcon message="Инструкция для ассистента" description="Опишите порядок действий, ожидаемый результат и ограничения. Здесь редактируется текст Markdown; название и описание задаются в карточке." />
                                <Form.Item label="Текст инструкции" name="body" rules={[{ required: true, whitespace: true, message: 'Добавьте инструкцию скилла' }, { validator: (_: unknown, value: string) => value?.includes('\0') || new TextEncoder().encode(value ?? '').length > 1024 * 1024 ? Promise.reject(new Error('Инструкция должна быть текстом до 1 МиБ, без нулевых символов.')) : Promise.resolve() }]}>
                                    <Input.TextArea autoSize={{ minRows: 13, maxRows: 24 }} className="store-edit-modal__code" spellCheck={false} />
                                </Form.Item>
                                <Form.Item name="resources" label="Ресурсы скилла"><SkillResources key={openedKey + reloadCount} disabled={busy || dependenciesBusy || !loaded} onLoadingChange={setResourcesBusy} /></Form.Item>
                            </> }] : editApp.kind === 'mcp' ? [{ key: 'config', label: 'Подключение MCP', forceRender: true, children: <>
                                <Alert type="info" showIcon message="Секреты остаются у пользователя" description={'Используйте ссылки вида {env:API_KEY}. Аргументы args задавайте массивом строк: пробелы внутри пути сохранятся.'} />
                                <Form.Item label="Настройки подключения, JSON" name="config" rules={[{ validator: (_: unknown, value: string) => { try { editMcpConfig(value); return Promise.resolve(); } catch (error: unknown) { return Promise.reject(error); } } }]}>
                                    <Input.TextArea autoSize={{ minRows: 13, maxRows: 24 }} className="store-edit-modal__code" spellCheck={false} />
                                </Form.Item>
                            </> }] : []),
                            { key: 'dependencies', label: 'Зависимости', forceRender: true, children: <>
                                {legacy.length > 0 && <>
                                    <Alert type="warning" showIcon message="Есть прежние требования без точной версии" description={<>
                                        <div>{legacy.join(', ')}</div><div>Такие требования блокируют установку комплекта. Закрепите нужные версии ниже и явно уберите прежние требования. Они сохранятся, пока вы не отметите поле.</div>
                                    </>} />
                                    <Form.Item name="clearLegacyRequirements" valuePropName="checked"><Checkbox>Убрать прежние требования без версии при сохранении</Checkbox></Form.Item>
                                </>}
                                <Form.Item name="dependencies" label="MCP и плагины" rules={[{validator: (_: unknown, value: unknown) => {
                                    try { checkDependencyPins(value ?? []); return Promise.resolve(); } catch (cause) { return Promise.reject(cause); }
                                }}]}><DependencyPinsEditor key={openedKey + ':' + reloadCount} ownId={isSkill ? undefined : editApp.id} disabled={busy || resourcesBusy || !loaded} onLoadingChange={setDependenciesBusy} /></Form.Item>
                            </> },
                        ]} />
                    </Form>
                </Spin>
            </>}
        </Modal>
    );
};

export default StoreEditModal;
