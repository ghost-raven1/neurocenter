import { Alert, Button, Card, Select, Space, Spin, Typography } from 'antd';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import type { IRagIndexProfile } from '../../core/api/interfaces';
import { projectRoleLevel } from '../UserBlock/roles';
import { eligibleEmbedding, embeddingNeedsRepair, sameEmbeddingProfile } from './model';
import { useProjectEmbedding } from './useProjectEmbedding';
import { ProjectEmbeddingConnection } from './ProjectEmbeddingConnection';
import './ProjectEmbedding.less';
import type {IRagUiPreference} from '../McpBridge/ragUi/ragUiPreference';

interface IProps { projectId: string; indexProfile?: IRagIndexProfile | null; serverHasData: boolean; onPreferRagUi?:(value:IRagUiPreference)=>void; }
/** Локальный выбор и запросы принадлежат точному проекту, роли и сеансу. */
export function ProjectEmbedding(props: IProps): JSX.Element {
    const { scope } = useAuthRequestOwner();
    const user = useSelector((state: RootState) => state.userBlock.user);
    const level = projectRoleLevel(user, props.projectId);
    return <ProjectEmbeddingContent key={JSON.stringify([scope, props.projectId, level])} {...props} canManage={level >= 3} canConnect={level >= 2} />;
}
export function ProjectEmbeddingContent({projectId,indexProfile,serverHasData,canManage,canConnect,onPreferRagUi}: IProps & {canManage: boolean; canConnect: boolean}): JSX.Element {
    const state = useProjectEmbedding(projectId);
    const {selection,catalog,modelId} = state;
    const assigned = new Set(catalog?.assignedModelIds ?? []);
    const models = selection ? catalog?.items.filter(model => assigned.has(model.id) && eligibleEmbedding(model, selection.expectedDimension)) ?? [] : [];
    const dirty = !!selection && (modelId !== (selection.model?.id ?? null) || embeddingNeedsRepair(selection));
    const selected = models.find(model => model.id === modelId);
    const invalidDraft = modelId !== null && !selected;
    const mismatch = serverHasData && !!selection?.profile && (!indexProfile || !sameEmbeddingProfile(indexProfile, selection.profile));
    const catalogUrl = `/projects/${encodeURIComponent(projectId)}?tab=store&catalogTab=models`;
    return <Card size="small" title="Модель эмбеддингов проекта" className="project-embedding"
        extra={<Button type="link" loading={state.loading || state.catalogLoading} disabled={state.saving} onClick={() => { void state.refresh(); }}>Обновить сведения</Button>}>
        <Space direction="vertical" size={16} className="project-embedding__content">
            <Typography.Paragraph type="secondary">Выбор модели сохраняется для команды. Подключение к OpenCodeRAG выполняется отдельно на выбранном компьютере; существующие индексы сохраняются.</Typography.Paragraph>
            {state.readError && <Alert showIcon type="warning" message="Сведения о модели недоступны" description={state.readError}
                action={<Button loading={state.loading} disabled={state.saving} onClick={() => { void state.refresh(); }}>Повторить загрузку</Button>} />}
            {state.catalogError && <Alert showIcon type="warning" message="Каталог моделей недоступен" description={`${state.catalogError} ${state.catalogAccessDenied ? 'Подключение недоступно до актуальной проверки доступа.' : 'Изменение выбора недоступно; сохранённая модель читается отдельно.'}`}
                action={<Button loading={state.catalogLoading} disabled={state.saving} onClick={() => { void state.refresh(); }}>Повторить загрузку каталога</Button>} />}
            {!selection && state.loading && <Spin />}
            {selection && <>
                <Typography.Text>Сохранённая модель: <strong>{selection.model?.name || 'не выбрана'}</strong>{selection.model ? ` · ${selection.model.model} · ${selection.model.dimension} измерений` : ''}.</Typography.Text>
                {canManage ? <Space direction="vertical" size={8} className="project-embedding__selection">
                    <Select aria-label="Модель эмбеддингов проекта" placeholder="Выберите назначенную embedding-модель" value={modelId ?? undefined} allowClear showSearch optionFilterProp="label"
                        disabled={state.loading || state.catalogLoading || state.saving || !!state.readError || !!state.catalogError} onChange={(id?: string) => state.choose(id ?? null)}
                        options={models.map(model => ({value: model.id, label: `${model.name} · ${model.dimension} измерений`}))} />
                    {invalidDraft && !state.catalogError && !state.catalogLoading && <Typography.Text type="warning">Выбранная модель больше не доступна для этого проекта. Выберите другую модель или очистите выбор.</Typography.Text>}
                    {!models.length && !state.catalogError && !state.catalogLoading && <Typography.Text type="secondary">Назначьте проекту embedding-модель с закреплённым SHA и размерностью {selection.expectedDimension} в каталоге.</Typography.Text>}
                    <Button type="primary" loading={state.saving} disabled={!dirty || invalidDraft || state.loading || state.catalogLoading || !!state.readError || !!state.catalogError} onClick={() => { void state.save(); }}>Сохранить модель проекта</Button>
                </Space> : <Typography.Text type="secondary">Модель выбирает администратор проекта. Подключить её к OpenCodeRAG может разработчик проекта.</Typography.Text>}
                {state.saveError && <Alert role="alert" type="error" showIcon message={state.saveError} description="Черновик сохранён в форме. Обновите сведения и проверьте текущий выбор перед повторным сохранением." />}
                {selection.blocker && <Alert type="warning" showIcon message={selection.blocker} />}
                {serverHasData && <Typography.Text type="secondary">Профиль существующей серверной копии: {indexProfile ? `${indexProfile.provider} · ${indexProfile.model} · ${indexProfile.dimension} измерений` : 'не подтверждён'}.</Typography.Text>}
                {mismatch && <Alert type="warning" showIcon message="Модель несовместима с существующей серверной копией"
                    description="Текущая серверная копия сохранена. Её профиль нельзя заменить обычной синхронизацией. Переход требует отдельной процедуры миграции или нового проекта; локальная переиндексация сама по себе это ограничение не снимает." />}
                {dirty && <Typography.Text type="secondary">Сначала сохраните выбранную модель. Подключение использует только подтверждённый выбор проекта.</Typography.Text>}
                {selection.model && selection.modelPin && selection.profile && !selection.blocker && canConnect && <ProjectEmbeddingConnection selection={selection}
                    disabled={dirty || state.loading || state.saving || !!state.readError || state.catalogAccessDenied} onPreferRagUi={onPreferRagUi} />}
            </>}
            <Button href={catalogUrl}>Открыть модели в каталоге проекта</Button>
        </Space>
    </Card>;
}
