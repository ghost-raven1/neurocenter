import {Alert, Button, Collapse, Drawer, Empty, Input, Modal, Space, Spin, Tabs, Tag, Tooltip, Typography} from 'antd';
import {useEffect, useState} from 'react';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {LearningAnalysisModal} from './LearningAnalysisModal';
import {LearningCandidateActionModal} from './LearningCandidateActionModal';
import {LearningCandidateList, type CandidateAction} from './LearningCandidateList';
import {LearningCandidateModal} from './LearningCandidateModal';
import {LearningCheckModal} from './LearningCheckModal';
import {LearningExperienceList} from './LearningExperienceList';
import {LearningExperienceModal} from './LearningExperienceModal';
import {LearningHistoryDrawer} from './LearningHistoryDrawer';
import {LearningHypothesisDetails} from './LearningHypothesisDetails';
import {LearningHypothesisList} from './LearningHypothesisList';
import {LearningHypothesisModal} from './LearningHypothesisModal';
import {analysisStateLabel, learningCandidates} from './model';
import {learningCountLabel} from './countLabels';
import {useLearningActions} from './useLearningActions';
import {useLearningAnalysis} from './useLearningAnalysis';
import {useLearningResources} from './useLearningResources';
import {useLearningHypothesis} from './useLearningHypothesis';
import {useProjectLearning} from './useProjectLearning';
import './ProjectLearning.less';

type Editor = {kind: 'experience' | 'hypothesis' | 'analysis'} | {kind: 'check' | 'candidate'; hypothesisId: string; previousCandidateId?: string} | {kind: CandidateAction; candidateId: string};

/** Evidence, unverified hypotheses and approved context remain distinct throughout the project workflow. */
export function ProjectLearning({projectId}: {projectId: string}): JSX.Element {
    const {scope} = useAuthRequestOwner();
    const source = useProjectLearning(projectId), {data} = source;
    const resources = useLearningResources(projectId, !!data?.capabilities.record);
    const analysis = useLearningAnalysis({projectId, data, refresh: source.refresh, blocked: source.loading || !!source.error});
    const actions = useLearningActions({projectId, data, refresh: source.refresh, blocked: source.loading || !!source.error || analysis.busy || analysis.pending || analysis.unconfirmed});
    const [editor, setEditor] = useState<Editor>(), [viewId, setViewId] = useState<string>(), [focusedCheckId, setFocusedCheckId] = useState<string>(), [history, setHistory] = useState(false);
    const [tab, setTab] = useState('hypotheses'), [query, setQuery] = useState('');
    useEffect(() => {setEditor(undefined); setViewId(undefined); setHistory(false); setTab('hypotheses'); setQuery('');}, [scope, projectId]);
    const close = (): void => setEditor(undefined);
    const open = (value: Editor): void => {actions.resetError(); setViewId(undefined); setEditor(value);};
    const blocked = source.loading || !!source.error || actions.busy || actions.unconfirmed || analysis.busy || analysis.pending || analysis.unconfirmed;
    const candidates = data ? learningCandidates(data) : [];
    const editorCandidate = editor && 'candidateId' in editor ? candidates.find(item => item.id === editor.candidateId) : undefined;
    const previousCandidate = editor && 'previousCandidateId' in editor ? candidates.find(item => item.id === editor.previousCandidateId) : undefined;
    const editorHypothesisId = editor && 'hypothesisId' in editor ? editor.hypothesisId : undefined;
    const details = useLearningHypothesis(projectId, viewId ?? editorHypothesisId, data?.hypotheses ?? [], viewId ? focusedCheckId : previousCandidate?.checkId), viewing = viewId ? details.hypothesis : null;
    const editorHypothesis = editorHypothesisId ? data?.hypotheses.find(item => item.id === editorHypothesisId) ?? (details.hypothesis?.id === editorHypothesisId ? details.hypothesis : undefined) : undefined;
    const openHypothesis = (id: string, checkId?: string): void => {setViewId(id); setFocusedCheckId(checkId);};
    const editorState = {busy: actions.busy, error: actions.error, conflict: actions.conflict, unconfirmed: actions.unconfirmed};
    if (!data) return <section className="project-learning">
        {source.error ? <Alert showIcon type="error" message={source.denied ? 'Обучение проекта недоступно' : 'Не удалось загрузить обучение'} description={source.error} action={<Button loading={source.loading} onClick={() => {void source.refresh();}}>Повторить</Button>} />
            : <div className="project-learning__loading" role="status"><Spin tip="Загружаем опыт и гипотезы…" /></div>}
    </section>;
    const filter = <T extends {title: string}>(items: T[]): T[] => items.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const more = (collection: 'experiences' | 'hypotheses' | 'candidates'): JSX.Element | null => data.pages[collection].nextCursor
        ? <div className="project-learning__load-more"><Button loading={source.loadingMore === collection} disabled={!!source.loadingMore || source.loading} onClick={() => {void source.loadMore(collection);}}>Загрузить ещё</Button><Typography.Text type="secondary">Загружено {data[collection].length} из {data.pages[collection].total}</Typography.Text></div> : null;
    const recover = (repeat: boolean): void => {void actions.recover(repeat).then(ok => {if (ok) close();});};
    return <section className="project-learning">
        <div className="project-learning__heading"><div><Typography.Title level={4}>Обучение проекта</Typography.Title>
            <Typography.Paragraph type="secondary">Сохраняйте опыт, проверяйте гипотезы и принимайте полезные выводы. Применение — только после одобрения человеком.</Typography.Paragraph></div>
            <Space wrap><Button onClick={() => setHistory(true)}>История</Button><Button loading={source.loading} disabled={actions.busy || analysis.busy} onClick={() => {void source.refresh(); void resources.refresh();}}>Обновить</Button></Space>
        </div>
        <div className="project-learning__summary"><span><strong>{data.pages.hypotheses.total}</strong> {learningCountLabel(data.pages.hypotheses.total, 'hypotheses')} в проекте</span><span><strong>{data.activeCandidates.length}</strong> {learningCountLabel(data.activeCandidates.length, 'knowledge')}</span><Tag>Только этот проект</Tag></div>
        <Collapse ghost className="project-learning__collection"><Collapse.Panel header="Как поступает опыт из OpenCode" key="collection"><Typography.Paragraph>Автосбор включается после подключения агентов новой версией моста и перезапуска OpenCode. Собираются только разрешённые названия инструментов, счётчики, статусы и время. Команды, вывод, промпты и секреты не отправляются.</Typography.Paragraph><Typography.Paragraph type="secondary">Окончание сессии не подтверждает успех задачи. Подробный опыт можно добавить здесь или сообщить через инструмент записи опыта в OpenCode. Знания применяются только после одобрения человеком.</Typography.Paragraph><Button href={'/store?' + new URLSearchParams({tab: 'agents', p: projectId}).toString()}>Открыть агентов проекта</Button></Collapse.Panel></Collapse>
        {source.error && <Alert className="project-learning__notice" showIcon type="warning" message="Показаны предыдущие данные. Запись временно недоступна." description={source.error} action={<Button onClick={() => {void source.refresh();}}>Повторить</Button>} />}
        {actions.error && !editor && <Alert className="project-learning__notice" showIcon type="error" message={actions.error} />}
        {actions.unconfirmed && <Alert className="project-learning__notice" showIcon type="warning" message="Предыдущий запрос ещё не подтверждён" description="Проверим квитанцию сервера. Повтор отправит исходный текст с прежним ключом; новое изменение пока недоступно."
            action={<Space wrap><Button loading={actions.busy} onClick={() => recover(false)}>Проверить результат</Button><Button disabled={actions.busy} onClick={() => recover(true)}>Повторить тот же запрос</Button></Space>} />}
        {analysis.unconfirmed && <Alert className="project-learning__notice" showIcon type="warning" message="Результат отправки анализа неизвестен" description={analysis.error || 'Восстановите состояние по сохранённой квитанции. Повторная генерация не запускается автоматически.'}
            action={<Space wrap><Button loading={analysis.busy} onClick={() => {void analysis.recover();}}>Проверить анализ</Button>{analysis.notFound && data.capabilities.record && <Button disabled={analysis.busy} onClick={() => {void analysis.recover(true);}}>Повторить отправку с прежним ключом</Button>}</Space>} />}
        {analysis.analysis && <Alert className="project-learning__notice" showIcon type={analysis.analysis.state === 'failed' || analysis.analysis.state === 'unknown' ? 'warning' : analysis.pending ? 'info' : 'success'}
            message={analysisStateLabel[analysis.analysis.state]} description={analysis.analysis.error?.message || (analysis.analysis.state === 'completed' ? `Создано гипотез: ${analysis.analysis.hypothesisIds.length}. Они ещё не проверены и не применены.` : 'Анализ использует выбранный опыт. Другие данные проекта не добавляются автоматически.')}
            action={analysis.pending ? <Spin size="small" /> : analysis.analysis.state === 'completed' ? <Button onClick={() => setTab('hypotheses')}>К гипотезам</Button> : data.capabilities.record && <Button disabled={blocked} onClick={() => open({kind: 'analysis'})}>Новый анализ</Button>} />}
        {analysis.error && !analysis.unconfirmed && !editor && <Alert className="project-learning__notice" type="warning" showIcon message={analysis.error} action={<Button disabled={analysis.busy} onClick={() => {void analysis.recover();}}>Проверить состояние</Button>} />}
        {resources.error && data.capabilities.record && <Alert className="project-learning__notice" type="warning" showIcon message="Список моделей или агентов недоступен" description={resources.error} action={<Button onClick={() => {void resources.refresh();}}>Повторить</Button>} />}
        <div className="project-learning__toolbar"><Input.Search aria-label="Поиск в загруженном опыте и гипотезах" placeholder="Поиск в загруженных записях…" allowClear value={query} onChange={event => setQuery(event.target.value)} />
            {data.capabilities.record && <Space wrap><Button disabled={blocked} onClick={() => open({kind: 'experience'})}>Добавить опыт</Button>
                <Tooltip title={!data.experiences.length ? 'Сначала сохраните опыт проекта.' : !resources.models.length ? 'Назначьте проекту доступную модель chat или vision.' : undefined}><span><Button type="primary" disabled={blocked || resources.loading || !data.experiences.length || !resources.models.length} onClick={() => open({kind: 'analysis'})}>Построить гипотезы</Button></span></Tooltip></Space>}
        </div>
        <Tabs activeKey={tab} onChange={setTab} items={[
            {key: 'hypotheses', label: `Гипотезы · ${data.pages.hypotheses.total}`, children: <><div className="project-learning__tab-heading"><Typography.Text type="secondary">Предположение → проверка → кандидат знания → одобрение</Typography.Text>{data.capabilities.record && <Button disabled={blocked || !data.experiences.length} onClick={() => open({kind: 'hypothesis'})}>Предложить свою</Button>}</div><LearningHypothesisList items={filter(data.hypotheses)} onOpen={openHypothesis} />{more('hypotheses')}</>},
            {key: 'experience', label: `Опыт · ${data.pages.experiences.total}`, children: <><LearningExperienceList items={filter(data.experiences)} />{more('experiences')}</>},
            {key: 'knowledge', label: `Знания · ${data.pages.candidates.total}`, children: <><Typography.Paragraph type="secondary">Одобренная действующая версия доступна агентам через контекст проекта. Исходные гипотезы и оценки моделей сами по себе не применяются.</Typography.Paragraph><LearningCandidateList items={filter(candidates)} canApprove={data.capabilities.approve} canRecord={data.capabilities.record} blocked={blocked} onVersion={candidate => open({kind: 'candidate', hypothesisId: candidate.hypothesisId, previousCandidateId: candidate.id})} onAction={(candidateId, action) => open({kind: action, candidateId})} onHypothesis={openHypothesis} />{more('candidates')}</>},
        ]} />
        {!data.capabilities.record && <Typography.Paragraph type="secondary">Ваша роль разрешает просмотр. Записывать опыт и проверки могут разработчики проекта; одобрять и отзывать знания — администраторы проекта.</Typography.Paragraph>}
        {viewing && <LearningHypothesisDetails key={viewing.id} hypothesis={viewing} experiences={data.experiences} canRecord={data.capabilities.record} canReview={data.capabilities.review} blocked={blocked} loading={details.loading} error={details.error} nextCursor={details.nextCursor} onMore={() => {void details.loadMore();}} onRetry={details.retry} onClose={() => setViewId(undefined)} onCheck={() => open({kind: 'check', hypothesisId: viewing.id})} onCandidate={() => open({kind: 'candidate', hypothesisId: viewing.id})} />}
        {viewId && !viewing && <Drawer open title="Исходная гипотеза" width={720} onClose={() => setViewId(undefined)}>{details.error ? <Alert showIcon type="error" message={details.error} action={<Button onClick={details.retry}>Повторить</Button>} /> : <Spin tip="Загружаем гипотезу и проверку…" />}</Drawer>}
        {history && <LearningHistoryDrawer data={data} onClose={() => setHistory(false)} />}
        {editor?.kind === 'experience' && data.capabilities.record && <LearningExperienceModal revision={data.revision} state={editorState} onClose={close} onSubmit={actions.execute} />}
        {editor?.kind === 'hypothesis' && data.capabilities.record && <LearningHypothesisModal revision={data.revision} experiences={data.experiences} state={editorState} onClose={close} onSubmit={actions.execute} />}
        {editor?.kind === 'check' && editorHypothesis && data.capabilities.review && <LearningCheckModal revision={data.revision} hypothesis={editorHypothesis} experiences={data.experiences} state={editorState} onClose={close} onSubmit={actions.execute} />}
        {editor?.kind === 'candidate' && editorHypothesis && data.capabilities.record && <LearningCandidateModal revision={data.revision} hypothesis={editorHypothesis} previous={previousCandidate} agents={resources.agents} state={editorState} onClose={close} onSubmit={actions.execute} />}
        {editorHypothesisId && !editorHypothesis && <Modal open title="Исходная гипотеза" onCancel={close} footer={<Button onClick={close}>Закрыть</Button>}>{details.error ? <Alert showIcon type="error" message={details.error} action={<Button onClick={details.retry}>Повторить</Button>} /> : <Spin tip="Загружаем основания версии…" />}</Modal>}
        {editor && 'candidateId' in editor && editorCandidate && data.capabilities.approve && <LearningCandidateActionModal revision={data.revision} candidate={editorCandidate} action={editor.kind} state={editorState} onClose={close} onSubmit={actions.execute} />}
        {editor?.kind === 'analysis' && data.capabilities.record && <LearningAnalysisModal revision={data.revision} experiences={data.experiences} models={resources.models} busy={analysis.busy} unconfirmed={analysis.unconfirmed} error={analysis.error} onClose={close} onStart={(ids, model, revision) => actions.busy || actions.unconfirmed ? Promise.resolve(false) : analysis.start(ids, model, revision)} />}
        {query && !filter(data.hypotheses).length && !filter(data.experiences).length && !filter(data.candidates).length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Поиск не дал результатов" />}
    </section>;
}
