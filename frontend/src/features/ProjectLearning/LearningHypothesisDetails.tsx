import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import {Alert, Button, Collapse, Drawer, Empty, List, Space, Tag, Typography} from 'antd';
import {useEffect, useRef, useState} from 'react';
import {formatDate} from '../../common/utils/format';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {projectLearningApi} from './api';
import {checkResultLabel, evidenceKindLabel, hypothesisStatus} from './model';
import type {LearningExperience, LearningHypothesis} from './types';

interface Props {hypothesis: LearningHypothesis; experiences: LearningExperience[]; canReview: boolean; canRecord: boolean; blocked: boolean; loading: boolean; error: string; nextCursor: string | null; onMore: () => void; onRetry: () => void; onClose: () => void; onCheck: () => void; onCandidate: () => void}

export function LearningHypothesisDetails(props: Props): JSX.Element {
    const {hypothesis} = props;
    const {captureOwner} = useAuthRequestOwner();
    const [additional, setAdditional] = useState<LearningExperience[]>([]), [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
    const [loadingIds, setLoadingIds] = useState<string[]>([]), requested = useRef(new Set<string>());
    const active = useRef(true);
    useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
    const sources = new Map([...props.experiences, ...additional].map(item => [item.id, item]));
    const loadSource = async (id: string): Promise<void> => {
        const owns = captureOwner(); if (!owns() || requested.current.has(id) || sources.has(id)) return;
        requested.current.add(id); setLoadingIds(previous => [...previous, id]);
        try {
            const experience = await projectLearningApi.experience(hypothesis.projectId, id);
            if (!owns() || !active.current) return;
            if (experience.id !== id || experience.projectId !== hypothesis.projectId || !Array.isArray(experience.evidence)) throw new Error('Источник не принадлежит гипотезе этого проекта.');
            setAdditional(previous => [...previous, experience]); setSourceErrors(previous => ({...previous, [id]: ''}));
        } catch (cause) {if (owns() && active.current) setSourceErrors(previous => ({...previous, [id]: errorMessage(cause, 'Не удалось загрузить источник.')}));}
        finally {requested.current.delete(id); if (owns() && active.current) setLoadingIds(previous => previous.filter(value => value !== id));}
    };
    const canPrepare = hypothesis.status === 'supported' && hypothesis.checks.some(check => check.method === 'human_review' && check.result === 'passed');
    return <Drawer open title={hypothesis.title} width={720} className="learning-details" onClose={props.onClose} footer={<Space wrap>
        {props.canReview && <FeatureButton features={['project_learning']} disabled={props.blocked} onClick={props.onCheck}>Записать проверку</FeatureButton>}
        {props.canRecord && <FeatureButton features={['project_learning']} type="primary" disabled={props.blocked || !canPrepare} onClick={props.onCandidate}>Подготовить знание</FeatureButton>}
    </Space>}>
        {props.error && <Alert type="warning" showIcon message={props.error} className="project-learning__notice" action={<Button onClick={props.onRetry}>Повторить</Button>} />}
        <Space wrap><Tag>{hypothesis.subject === 'agent' ? 'Работа агентов' : 'Проект и данные'}</Tag><Tag color={hypothesis.status === 'supported' ? 'green' : hypothesis.status === 'refuted' ? 'red' : 'default'}>{hypothesisStatus[hypothesis.status]}</Tag></Space>
        <Typography.Title level={5}>Предположение</Typography.Title><div className="project-learning__text">{hypothesis.statement}</div>
        <Typography.Title level={5}>Обоснование</Typography.Title><div className="project-learning__text">{hypothesis.rationale}</div>
        <Typography.Title level={5}>План проверки</Typography.Title><div className="project-learning__text">{hypothesis.verificationPlan}</div>
        <Typography.Title level={5}>Исходный опыт</Typography.Title>
        <Collapse ghost>{hypothesis.experienceIds.map(id => {
            const source = sources.get(id);
            return <Collapse.Panel key={id} header={source?.title ?? 'Основание из раннего опыта'}>{!source && <Button loading={loadingIds.includes(id)} onClick={() => {void loadSource(id);}}>Загрузить источник</Button>}{sourceErrors[id] && <Alert showIcon type="error" message={sourceErrors[id]} />}
                <Typography.Paragraph className="project-learning__text">{source?.summary}</Typography.Paragraph>
                {source?.evidence.map((item, index) => <div key={index} className="learning-details__evidence"><Tag>{evidenceKindLabel[item.kind]}</Tag><Tag>{item.status === 'passed' ? 'Успешно' : item.status === 'failed' ? 'Ошибка' : 'Не проверено'}</Tag>
                    <div className="project-learning__text">{item.summary}</div>{item.reference && <Typography.Text code copyable>{item.reference}</Typography.Text>}{item.sha256 && <Typography.Paragraph><Typography.Text code copyable>{item.sha256}</Typography.Text></Typography.Paragraph>}</div>)}
            </Collapse.Panel>;
        })}</Collapse>
        <Typography.Title level={5}>Проверки</Typography.Title>
        {hypothesis.checks.length ? <List dataSource={hypothesis.checks} renderItem={check => <List.Item><div>
            <Space wrap><Tag color={check.method === 'human_review' && check.result === 'passed' ? 'green' : 'default'}>{checkResultLabel[check.result]}</Tag><Typography.Text type="secondary">{check.method === 'human_review' ? 'Проверка человеком' : 'Оценка модели · не подтверждение'} · {formatDate(check.createdAt)}</Typography.Text></Space>
            <Typography.Paragraph className="project-learning__text">{check.summary}</Typography.Paragraph><Typography.Text type="secondary">{check.createdBy}</Typography.Text>
            <div>{check.experienceIds.map(id => sources.has(id) ? <Tag key={id}>{sources.get(id)!.title}</Tag> : <Button key={id} type="link" loading={loadingIds.includes(id)} onClick={() => {void loadSource(id);}}>Загрузить основание проверки</Button>)}</div>
            {check.experienceIds.map(id => sourceErrors[id] ? <Alert key={id} type="error" showIcon message={sourceErrors[id]} /> : null)}
        </div></List.Item>} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Проверок ещё нет. Эта гипотеза не является принятым знанием." />}
        {props.nextCursor && <Button loading={props.loading} onClick={props.onMore}>Загрузить ранние проверки · показано {hypothesis.checks.length} из {hypothesis.checkCount}</Button>}
        <Typography.Paragraph type="secondary">{hypothesis.model ? `Построена моделью ${hypothesis.model.modelId}. ` : 'Предложена человеком. '}Исходный текст сохраняется; будущий вывод можно отредактировать при подготовке знания.</Typography.Paragraph>
    </Drawer>;
}
