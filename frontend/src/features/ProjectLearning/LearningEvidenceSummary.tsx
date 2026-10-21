import {Collapse, Descriptions, Tag, Typography} from 'antd';
import {observationMetadata} from './observationMetadata';
import type {LearningExperience} from './types';

/** Automatic counters are presented as observations, never as proof of task success. */
export function LearningEvidenceSummary({origin, evidence}: {origin: LearningExperience['origin']; evidence: LearningExperience['evidence'][number]}): JSX.Element {
    const metadata = observationMetadata(origin, evidence);
    const reference = <>{evidence.reference && <Typography.Paragraph><Typography.Text code copyable>{evidence.reference}</Typography.Text></Typography.Paragraph>}
        {evidence.sha256 && <Typography.Paragraph><Typography.Text code copyable>{evidence.sha256}</Typography.Text></Typography.Paragraph>}</>;
    if (!metadata) return <><Typography.Paragraph className="project-learning__text">{evidence.summary}</Typography.Paragraph>{reference}</>;
    return <>
        <Descriptions size="small" column={1}>
            <Descriptions.Item label="Событие">{metadata.sessionEvent === 'idle' ? 'OpenCode ожидает следующий запрос' : 'Ошибка сессии OpenCode'}</Descriptions.Item>
            <Descriptions.Item label="Наблюдений инструментов">{metadata.calls}</Descriptions.Item>
            <Descriptions.Item label="Инструменты / количество">{Object.entries(metadata.toolObservations).map(([name, count]) => <Tag key={name}>{name}: {count}</Tag>)}{!metadata.calls && 'Не зафиксированы'}</Descriptions.Item>
            <Descriptions.Item label="Время наблюдения">{new Date(metadata.observedAt).toLocaleString('ru-RU')}</Descriptions.Item>
            <Descriptions.Item label="Длительность">{new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 1}).format(metadata.elapsedMs / 1000)} с</Descriptions.Item>
        </Descriptions>
        {metadata.truncated && <Typography.Paragraph type="warning">Достигнут лимит наблюдений. Счётчики неполные.</Typography.Paragraph>}
        <Typography.Paragraph type="secondary">Это служебные наблюдения; они не подтверждают успех задачи.</Typography.Paragraph>
        <Collapse ghost><Collapse.Panel key="metadata" header="Исходные метаданные"><Typography.Paragraph className="project-learning__text">{evidence.summary}</Typography.Paragraph>{reference}</Collapse.Panel></Collapse>
    </>;
}
