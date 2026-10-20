import { Alert, Button, Collapse, Descriptions, Empty, List, Space, Spin, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import StatusTag from '../../common/components/StatusTag';
import { errorMessage } from '../../common/utils/errorMessage';
import bffApi from '../../core/api/bff';
import type { IAuditEvent, IOperationDetail } from '../../core/api/interfaces';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { auditActorLabel, describeAuditAction, featureFlagAuditChanges, formatAuditTime, maintenanceAuditChanges } from './auditHelpers';
import { auditEventSummary, auditResourceKind, auditResourceTitle, publicationAuditChanges } from './auditPresentation';

const { Paragraph, Text } = Typography;
const LEVEL_LABELS: Record<string, string> = { INFO: 'Информация', WARN: 'Внимание', ERROR: 'Ошибка', DEBUG: 'Отладка' };

/** Детали только связанной реальной операции; ошибки загрузки не подменяются пустым журналом. */
export default function AuditDetails({ event }: { event: IAuditEvent }): JSX.Element {
    const [ detail, setDetail ] = useState<IOperationDetail | null>(null);
    const [ loading, setLoading ] = useState(Boolean(event.correlationId));
    const [ error, setError ] = useState<string | null>(null);
    const [ attempt, setAttempt ] = useState(0);
    const retry = useCallback(() => setAttempt(value => value + 1), []);
    const flagEvent=event.action==='feature_flag.update';
    const changes=flagEvent?featureFlagAuditChanges(event.details):maintenanceAuditChanges(event.details);
    const publicationChanges = publicationAuditChanges(event);
    const summary = auditEventSummary(event);
    useSectionUpdates(['audit', 'operations'], retry, Boolean(event.correlationId));

    useEffect(() => {
        if (!event.correlationId) { return; }
        let current = true;
        setLoading(true);
        setError(null);
        bffApi.getOperation(event.correlationId)
            .then(result => {
                if (!result || result.operationId !== event.correlationId) { throw new Error('Связанная операция не найдена'); }
                if (current) { setDetail(result); }
            })
            .catch(failure => { if (current) { setError(errorMessage(failure, 'Не удалось загрузить подробности операции')); } })
            .finally(() => { if (current) { setLoading(false); } });
        return () => { current = false; };
    }, [ event.correlationId, attempt ]);

    return <div className="audit-page__detail">
        <Space size="small" wrap><Tag color={describeAuditAction(event.action).color}>{describeAuditAction(event.action).label}</Tag><StatusTag status={detail?.state ?? event.outcome} />{loading && detail && <Spin size="small" />}</Space>
        <Typography.Title level={4}>{auditResourceTitle(event)}</Typography.Title>
        <Text type="secondary">{auditResourceKind(event)}</Text>
        {summary && <Paragraph className="audit-page__event-summary">{summary}</Paragraph>}
        <Descriptions column={1} size="small" className="audit-page__detail-meta">
            <Descriptions.Item label="Время">{formatAuditTime(event.at)}</Descriptions.Item>
            <Descriptions.Item label="Исполнитель">{auditActorLabel(event.actor)}</Descriptions.Item>
        </Descriptions>
        {(!event.actor || event.actor === 'admin') && <Paragraph type="secondary">В исходной записи не сохранена почта пользователя: указан технический исполнитель {event.actor || 'без имени'}.</Paragraph>}
        {changes.length>0&&<Descriptions title={flagEvent?'Изменение функции':'Изменённые настройки обслуживания'} column={1} size="small">{changes.map(change=><Descriptions.Item key={change.label} label={change.label}><Text delete>{change.before}</Text> → <Text>{change.after}</Text></Descriptions.Item>)}</Descriptions>}
        {publicationChanges.length > 0 && <Descriptions title="Что изменилось" className="audit-page__changes" layout="vertical" column={1} size="small">{publicationChanges.map(change => <Descriptions.Item key={change.label} label={change.label}>
            <span className="audit-page__change-values">{change.label === 'Содержимое и настройки комплекта'
                ? 'Изменено содержимое или настройки. Построчные изменения в этой записи не сохранены.'
                : event.action === 'plugin.create' ? change.after : event.action === 'plugin.delete' ? change.before : <><Text delete>{change.before}</Text> → <Text>{change.after}</Text></>}</span>
        </Descriptions.Item>)}</Descriptions>}
        {!event.correlationId && !summary && changes.length === 0 && <Alert showIcon type="info" message="Подробный состав изменений не сохранён" description="В этой записи доступны дата, действие, исполнитель и результат. Исторические значения не восстанавливаются из текущего каталога." />}
        {loading && !detail && <div className="audit-page__loading"><Spin tip="Загружаем подробности…" /></div>}
        {error && <Alert
            showIcon type="error" message={detail ? 'Не удалось обновить подробности — показаны предыдущие данные' : 'Подробности недоступны'} description={error}
            action={<Button size="small" loading={loading} onClick={retry}>Повторить</Button>}
        />}
        {detail && <>
            <div className="audit-page__operation-status"><Text strong>Состояние операции</Text><StatusTag status={detail.state} /></div>
            <Descriptions column={1} size="small">
                <Descriptions.Item label="Начало">{formatAuditTime(detail.startedAt)}</Descriptions.Item>
                <Descriptions.Item label="Завершение">{detail.finishedAt ? formatAuditTime(detail.finishedAt) : 'Не завершена'}</Descriptions.Item>
                {detail.projectId && <Descriptions.Item label="Проект"><Button type="link" size="small" href={`/projects/${encodeURIComponent(detail.projectId)}`}>{detail.projectId}</Button></Descriptions.Item>}
                <Descriptions.Item label="Повторных запусков">{detail.retries}</Descriptions.Item>
            </Descriptions>
            {detail.error && <Alert type="error" showIcon message="Ошибка операции" description={detail.error} />}
            <Typography.Title level={5}>Журнал операции</Typography.Title>
            <List
                className="audit-page__log"
                dataSource={detail.log}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Сообщений в журнале операции нет" /> }}
                renderItem={(item, index) => <List.Item key={`${item.at}-${index}`}>
                    <Space wrap><Text type="secondary">{formatAuditTime(item.at)}</Text><Tag color={item.level === 'ERROR' ? 'error' : item.level === 'WARN' ? 'warning' : 'default'}>{LEVEL_LABELS[item.level] ?? item.level}</Tag></Space>
                    <Paragraph className="audit-page__log-message">{item.message}</Paragraph>
                </List.Item>}
            />
        </>}
        <Collapse ghost className="audit-page__technical"><Collapse.Panel header="Технические сведения" key="technical">
            <Descriptions column={1} size="small">
                <Descriptions.Item label="ID ресурса"><Text copyable>{event.resourceId || 'не указан'}</Text></Descriptions.Item>
                <Descriptions.Item label="Код действия"><Text code>{event.action || 'не указан'}</Text></Descriptions.Item>
                <Descriptions.Item label="ID события"><Text copyable>{event.id}</Text></Descriptions.Item>
                {event.correlationId && <Descriptions.Item label="ID операции"><Text copyable>{event.correlationId}</Text></Descriptions.Item>}
                {event.decisionId && <Descriptions.Item label="Решение доступа"><Text code>{event.decisionId}</Text></Descriptions.Item>}
            </Descriptions>
        </Collapse.Panel></Collapse>
    </div>;
}
