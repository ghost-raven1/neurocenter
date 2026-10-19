import { DashboardOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Descriptions, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { FC } from 'react';
import { useSelector } from 'react-redux';

import { formatBytes } from '../../common/utils/format';
import type { RootState } from '../../store';

import { capacityResourceLabels } from './capacityStatusController';
import type { ICapacityResource } from './capacityStatusController';
import { useCapacityStatus } from './useCapacityStatus';

type TCapacityRow = ICapacityResource & { resource: string };

const AccountCapacityStatus: FC = () => {
    const { data, loading, error, refresh } = useCapacityStatus();
    const reserveBytes = data?.reserveBytes || 0;
    const rows: TCapacityRow[] = Object.entries(data?.resources || {}).map(([resource, value]) => ({ resource, ...value }));
    const columns: ColumnsType<TCapacityRow> = [
        {
            title: 'Ресурс', dataIndex: 'resource', width: 260,
            render: (value: string) => capacityResourceLabels[value] || value,
        },
        {
            title: 'Свободно', key: 'free', width: 180,
            render: (_, row) => (
                <Space wrap>
                    <Typography.Text>{formatBytes(row.freeBytes)}</Typography.Text>
                    {row.freeBytes < Math.max(reserveBytes, row.totalBytes * 0.15) && <Tag color="error">Мало места</Tag>}
                </Space>
            ),
        },
        { title: 'Всего', dataIndex: 'totalBytes', width: 120, render: (value: number) => formatBytes(value) },
    ];
    const notConfigured = data?.reason === 'CAPACITY_NOT_CONFIGURED';

    return (
        <Card
            className="maintenance-page__physical-capacity"
            title={<Space><DashboardOutlined /><span>Физическое место на сервере</span></Space>}
            extra={<Button loading={loading} onClick={() => void refresh()}>Обновить замер</Button>}
        >
            {error && <Alert className="maintenance-page__notice" type="error" showIcon message={error} />}
            {data?.available ? <>
                <Descriptions className="maintenance-page__capacity-summary" size="small" layout="vertical" column={{ xs: 1, sm: 2 }}>
                    <Descriptions.Item label="Замер">
                        {data.observedAt ? new Date(data.observedAt).toLocaleString('ru-RU') : 'Неизвестно'}
                    </Descriptions.Item>
                    <Descriptions.Item label="Резерв перед тяжёлой записью">{formatBytes(reserveBytes)}</Descriptions.Item>
                </Descriptions>
                <Table
                    className="maintenance-page__capacity-table" size="small" rowKey="resource" pagination={false}
                    scroll={{ x: 560 }} dataSource={rows} columns={columns}
                />
                <Typography.Paragraph type="secondary" className="maintenance-page__scope">
                    Несколько ресурсов могут использовать один диск; размеры не суммируются. Временные записи используют
                    соответствующие рабочие тома. При недостатке места или устаревшем замере новая тяжёлая операция отклоняется.
                </Typography.Paragraph>
            </> : data && <Alert
                showIcon type={notConfigured ? 'info' : 'error'}
                message={notConfigured ? 'Сборщик физических ресурсов не подключён' : 'Свежий физический замер недоступен'}
                description="Размеры служебных баз ниже не показывают свободное место диска. В production проверьте состояние capacity-collector."
            />}
        </Card>
    );
};

/** Физический замер не смешивается с логическими квотами и данными другого аккаунта. */
const CapacityStatus: FC = () => {
    const user = useSelector((state: RootState) => state.userBlock.user);
    if (user?.activeRole !== 'Главный админ') { return null; }
    return <AccountCapacityStatus key={`${user.id}:${user.email}:${user.activeRole}`} />;
};

export default CapacityStatus;
