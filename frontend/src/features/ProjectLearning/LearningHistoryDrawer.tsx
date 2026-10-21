import {Alert, Button, Drawer, Empty, List, Space, Tag, Typography} from 'antd';
import {useRef, useState} from 'react';
import {formatDate} from '../../common/utils/format';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {projectLearningApi} from './api';
import type {LearningOverview} from './types';

const labels: Record<string, string> = {'experience.record': 'Опыт записан', 'experience.observe': 'Получено наблюдение с компьютера', 'hypothesis.propose': 'Гипотеза предложена', 'hypothesis.analyze': 'Гипотезы построены моделью', 'hypothesis.check': 'Проверка записана', 'candidate.propose': 'Знание отправлено на одобрение', 'candidate.approve': 'Знание одобрено', 'candidate.reject': 'Кандидат отклонён', 'candidate.revoke': 'Знание отозвано', 'candidate.activate': 'Возвращена предыдущая версия'};

export function LearningHistoryDrawer({data, onClose}: {data: LearningOverview; onClose: () => void}): JSX.Element {
    const {captureOwner} = useAuthRequestOwner();
    const [older, setOlder] = useState<LearningOverview['history']>([]), [more, setMore] = useState(data.history.length === 100), [loading, setLoading] = useState(false), [error, setError] = useState('');
    const lock = useRef(false);
    const items = [...new Map([...data.history, ...older].map(item => [item.id, item])).values()].sort((a, b) => b.revision - a.revision);
    const loadMore = async (): Promise<void> => {
        const owns = captureOwner(); if (!owns() || lock.current || !items.length) return;
        lock.current = true; setLoading(true); setError('');
        try {
            const next = await projectLearningApi.history(data.projectId, items[items.length - 1].revision);
            if (!owns()) return;
            if (!Array.isArray(next) || next.some(item => item.projectId !== data.projectId || item.revision >= items[items.length - 1].revision)) throw new Error('Некорректная страница истории.');
            setOlder(previous => [...previous, ...next]); setMore(next.length === 100);
        } catch (cause) {if (owns()) setError(errorMessage(cause, 'Не удалось загрузить ранние события.'));}
        finally {if (owns()) {lock.current = false; setLoading(false);}}
    };
    const names = new Map([...data.experiences, ...data.hypotheses, ...data.candidates].map(item => [item.id, item.title]));
    return <Drawer open width={660} title="История обучения проекта" onClose={onClose} className="learning-details">
        {items.length ? <List dataSource={items} renderItem={item => <List.Item><div>
            <Space wrap><Typography.Text strong>{labels[item.action.replace(/^learning\./, '')] ?? item.action}</Typography.Text><Tag>Ревизия {item.revision}</Tag></Space>
            <Typography.Paragraph>{names.get(item.resourceId) ?? (typeof item.details.hypothesisId === 'string' ? names.get(item.details.hypothesisId) : undefined) ?? item.resourceId}</Typography.Paragraph>
            <Typography.Text type="secondary">{item.actor} · {formatDate(item.createdAt)}</Typography.Text>
            {typeof item.details.key === 'string' && <Typography.Paragraph><Typography.Text code>{item.details.key}</Typography.Text>{typeof item.details.version === 'number' ? ` · v${item.details.version}` : ''}</Typography.Paragraph>}
        </div></List.Item>} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="История пока пуста" />}
        {error && <Alert showIcon type="error" message={error} />}{more && <Button loading={loading} onClick={() => {void loadMore();}}>Загрузить ранние события</Button>}
        <Typography.Paragraph type="secondary">Показано событий: {items.length}. Исходный опыт, версии и решения сохраняются на сервере.</Typography.Paragraph>
    </Drawer>;
}
