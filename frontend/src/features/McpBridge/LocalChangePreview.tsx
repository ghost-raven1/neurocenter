import { Alert, Empty, List, Space, Tag, Typography } from 'antd';
import type { ILocalChangePlan } from './operationTypes';
import './localOperations.less';

const labels = {add:'Добавить',replace:'Заменить',remove:'Удалить'};
/** Только публичные метаданные: исходники и резервные байты остаются на компьютере. */
export function LocalChangePreview({plan}: {plan:ILocalChangePlan}) {
    return <Space direction="vertical" className="local-operation">
        <Typography.Text type="secondary">Сравнение: {new Date(plan.checkedAt).toLocaleString('ru-RU')} · действует до {new Date(plan.expiresAt).toLocaleTimeString('ru-RU')}</Typography.Text>
        {plan.runtimeRepairRequired && <Alert type="warning" showIcon message="Нужно восстановить готовый комплект"
            description="После подтверждения мост повторно загрузит одобренный комплект и проверит SHA. Повреждённые файлы, если они сохранились, останутся в отдельной копии на компьютере. До успешной проверки файлы проекта не меняются." />}
        {plan.files.length ? <List className="local-operation__files" size="small" dataSource={plan.files} rowKey="path" renderItem={file => <List.Item>
            <Space direction="vertical" size={4} style={{width:'100%'}}>
                <Space wrap><Tag>{labels[file.operation]}</Tag><Typography.Text code className="local-operation__hash">{file.path}</Typography.Text>{file.binary && <Tag>Двоичный файл</Tag>}</Space>
                <Typography.Text type="secondary" className="local-operation__hash">До: {file.beforeSha256 || 'Файл отсутствует'} · {file.beforeBytes} байт</Typography.Text>
                <Typography.Text type="secondary" className="local-operation__hash">После: {file.afterSha256 || 'Файл будет удалён'} · {file.afterBytes} байт</Typography.Text>
            </Space>
        </List.Item>} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={plan.runtimeRepairRequired ? 'В файлах проекта изменений не будет' : 'Файлы инструмента и подключения сохранятся без изменений'} />}
    </Space>;
}
