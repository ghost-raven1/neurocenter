import {Button, Empty, List, Space, Tag, Typography} from 'antd';
import {hypothesisStatus} from './model';
import type {LearningHypothesis} from './types';

export function LearningHypothesisList({items, onOpen}: {items: LearningHypothesis[]; onOpen: (id: string) => void}): JSX.Element {
    if (!items.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Гипотез пока нет. Постройте их по выбранному опыту или предложите свою." />;
    return <List className="learning-hypotheses" dataSource={items} renderItem={item => <List.Item className="project-learning__row">
        <div className="project-learning__row-main"><Button type="link" className="project-learning__title-button" onClick={() => onOpen(item.id)}>{item.title}</Button>
            <Typography.Paragraph ellipsis={{rows: 2}}>{item.statement}</Typography.Paragraph>
            <Space wrap><Tag>{item.subject === 'agent' ? 'Работа агентов' : 'Проект и данные'}</Tag><Tag color={item.status === 'supported' ? 'green' : item.status === 'refuted' ? 'red' : 'default'}>{hypothesisStatus[item.status]}</Tag>
                <Typography.Text type="secondary">Оснований: {item.experienceIds.length} · Проверок: {item.checkCount}{item.model ? ' · Предложена моделью' : ''}</Typography.Text></Space>
        </div><Button onClick={() => onOpen(item.id)}>Подробнее</Button>
    </List.Item>} />;
}
