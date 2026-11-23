import { Descriptions, Empty, Space, Tag, Typography } from 'antd';
import { FC } from 'react';
import { useHistory } from 'react-router-dom';

import type { IErrorEvent } from '../../core/api/interfaces';

import {
    auditLinkForRequestId,
    describeErrorMessage,
    describeErrorLevel,
    errorStackFrames,
    formatErrorTime,
} from './errorPresentation';
import './Error.less';

const { Text } = Typography;

/**
 * Детали error-события: только safe-поля. Stack-hint показывается как кадры —
 * сырой stack не отображается (AD-O8).
 */
const ErrorDetails: FC<{ event: IErrorEvent }> = ({ event }) => {
    const history = useHistory();
    const frames = errorStackFrames(event.stackHint);
    const level = describeErrorLevel(event.level);

    return (
        <div className="error-page__detail">
            <Descriptions column={1} bordered size="small">
                <Descriptions.Item label="Дата и время">{formatErrorTime(event.ts)}</Descriptions.Item>
                <Descriptions.Item label="Сервис">{event.service}</Descriptions.Item>
                <Descriptions.Item label="Уровень">
                    <Tag color={level.color}>{level.label}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="Сообщение">{describeErrorMessage(event.message)}</Descriptions.Item>
                <Descriptions.Item label="Request ID">
                    {event.requestId ? (
                        <Space direction="vertical" size={4}>
                            <Text copyable>{event.requestId}</Text>
                            <Typography.Link
                                onClick={() => history.push(auditLinkForRequestId(event.requestId as string))}
                            >
                                Открыть в истории действий
                            </Typography.Link>
                        </Space>
                    ) : (
                        <Text type="secondary">Не задан</Text>
                    )}
                </Descriptions.Item>
            </Descriptions>
            <div className="error-page__detail-meta">
                <Text strong>Кадры (без значений)</Text>
                {frames.length ? (
                    <pre className="error-page__stack">{frames.join('\n')}</pre>
                ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Кадры не зафиксированы" />
                )}
            </div>
        </div>
    );
};

export default ErrorDetails;
