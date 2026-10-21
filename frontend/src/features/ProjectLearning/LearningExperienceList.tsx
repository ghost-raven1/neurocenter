import {Collapse, Empty, Space, Tag, Typography} from 'antd';
import {formatDate} from '../../common/utils/format';
import {evidenceKindLabel, outcomeLabel} from './model';
import type {LearningExperience} from './types';
import {LearningEvidenceSummary} from './LearningEvidenceSummary';

export function LearningExperienceList({items}: {items: LearningExperience[]}): JSX.Element {
    if (!items.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Опыт ещё не записан. Добавьте результат задачи, проверки или обратную связь." />;
    return <Collapse className="learning-experiences">{items.map(item => <Collapse.Panel key={item.id} header={<div className="project-learning__row-title"><Typography.Text strong>{item.title}</Typography.Text><Space wrap><Tag>{outcomeLabel[item.outcome]}</Tag><Typography.Text type="secondary">{formatDate(item.createdAt)}</Typography.Text></Space></div>}>
        <Typography.Paragraph className="project-learning__text">{item.summary}</Typography.Paragraph>
        {item.evidence.map((evidence, index) => <div className="learning-details__evidence" key={index}><Space wrap><Tag>{evidenceKindLabel[evidence.kind]}</Tag><Tag color={evidence.status === 'failed' ? 'red' : 'default'}>{evidence.status === 'passed' ? 'Успешно' : evidence.status === 'failed' ? 'Ошибка' : 'Не проверено'}</Tag></Space>
            <LearningEvidenceSummary origin={item.origin} evidence={evidence} />
        </div>)}
        <Space wrap><Typography.Text type="secondary">{item.origin === 'device' ? 'Наблюдение с компьютера' : 'Добавлено человеком'} · {item.createdBy}</Typography.Text>{item.context.gitCommit && <Typography.Text code copyable>{item.context.gitCommit}</Typography.Text>}</Space>
    </Collapse.Panel>)}</Collapse>;
}
