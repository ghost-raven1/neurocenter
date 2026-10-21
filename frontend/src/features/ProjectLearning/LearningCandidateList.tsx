import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import {Button, Collapse, Empty, Radio, Space, Tag, Typography} from 'antd';
import {useState} from 'react';
import {formatDate} from '../../common/utils/format';
import {activeLearning, candidateStatus} from './model';
import type {LearningCandidate} from './types';

export type CandidateAction = 'approve' | 'reject' | 'revoke' | 'activate';
interface Props {items: LearningCandidate[]; canApprove: boolean; canRecord?: boolean; blocked: boolean; onVersion?: (item: LearningCandidate) => void; onAction: (id: string, action: CandidateAction) => void; onHypothesis: (id: string, checkId: string) => void}

export function LearningCandidateList(props: Props): JSX.Element {
    const [filter, setFilter] = useState<'all' | 'active' | 'proposed'>('all');
    const items = props.items.filter(item => filter === 'all' || filter === 'active' && activeLearning(item) || filter === 'proposed' && item.status === 'proposed');
    return <><Radio.Group className="project-learning__filters" value={filter} onChange={event => setFilter(event.target.value)} optionType="button" buttonStyle="solid" options={[{value: 'all', label: 'Все версии'}, {value: 'proposed', label: 'На одобрении'}, {value: 'active', label: 'Действующие'}]} />
        {!items.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filter === 'proposed' ? 'Кандидатов на одобрение нет' : filter === 'active' ? 'Действующих знаний пока нет' : 'После успешной проверки подготовьте гипотезу к одобрению'} /> : <div className="learning-candidates">{items.map(item => <article key={item.id} className="learning-candidate">
            <div className="project-learning__row-title"><Typography.Text strong>{item.title}</Typography.Text><Space wrap><Tag>v{item.version}</Tag><Tag color={activeLearning(item) ? 'green' : item.status === 'proposed' ? 'blue' : 'default'}>{activeLearning(item) ? 'Действует' : candidateStatus[item.status]}</Tag></Space></div>
            <Typography.Paragraph type="secondary"><Typography.Text code>{item.key}</Typography.Text> · {item.kind === 'instruction' ? 'Инструкция агенту' : 'Вывод о проекте'}{item.targetAgentId ? ` · Агент ${item.targetAgentId}` : ' · Весь проект'}</Typography.Paragraph>
            <Collapse ghost><Collapse.Panel header="Текст и основания" key="content"><div className="project-learning__text">{item.content}</div><Button type="link" className="project-learning__title-button" onClick={() => props.onHypothesis(item.hypothesisId, item.checkId)}>Гипотеза и проверка</Button>
                <Typography.Paragraph type="secondary">Создал {item.createdBy} · {formatDate(item.createdAt)}{item.approvedBy ? ` · Одобрил ${item.approvedBy}` : ''}</Typography.Paragraph>
                {item.reason && <Typography.Paragraph className="project-learning__text">Решение: {item.reason}</Typography.Paragraph>}
            </Collapse.Panel></Collapse>
            {props.canApprove && <Space wrap className="learning-candidate__actions">
                {item.status === 'proposed' && <><FeatureButton features={['project_learning']} type="primary" disabled={props.blocked} onClick={() => props.onAction(item.id, 'approve')}>Проверить и одобрить</FeatureButton><FeatureButton features={['project_learning']} disabled={props.blocked} onClick={() => props.onAction(item.id, 'reject')}>Отклонить</FeatureButton></>}
                {activeLearning(item) && <Button danger disabled={props.blocked} onClick={() => props.onAction(item.id, 'revoke')}>Отозвать</Button>}
                {item.status === 'approved' && !item.active && <FeatureButton features={['project_learning']} disabled={props.blocked} onClick={() => props.onAction(item.id, 'activate')}>Вернуть эту версию</FeatureButton>}
            </Space>}
            {props.canRecord && <FeatureButton features={['project_learning']} className="learning-candidate__version" disabled={props.blocked} onClick={() => props.onVersion?.(item)}>Подготовить новую версию</FeatureButton>}
        </article>)}</div>}
    </>;
}
