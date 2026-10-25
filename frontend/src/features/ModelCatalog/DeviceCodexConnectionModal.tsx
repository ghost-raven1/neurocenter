import {Alert, Button, Descriptions, Modal, Space, Spin, Typography} from 'antd';
import {useEffect, useRef, useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import baseApi from '../../core/api/base';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import type {ICatalogModel, IDeviceCodexConnection} from './types';

interface IProps {
    model: ICatalogModel;
    onClose: () => void;
    onConfigureOpenCode?: (deviceId: string) => void;
}

/** Проверяет доступность компьютера без вызова модели и без переноса локального входа. */
export function DeviceCodexConnectionModal({model, onClose, onConfigureOpenCode}: IProps): JSX.Element {
    const {scope, captureOwner} = useAuthRequestOwner();
    const [connection, setConnection] = useState<IDeviceCodexConnection>();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [reload, setReload] = useState(0);
    const generation = useRef(0);
    useEffect(() => {
        const current = ++generation.current, owns = captureOwner(), cancellation = new AbortController();
        setLoading(true);
        void baseApi.get<IDeviceCodexConnection>('/api/models/' + encodeURIComponent(model.id) + '/device-connection', {signal: cancellation.signal})
            .then(({data}) => {if (owns() && current === generation.current) {setConnection(data); setError('');}})
            .catch(cause => {if (!cancellation.signal.aborted && owns() && current === generation.current) setError(errorMessage(cause, 'Не удалось проверить компьютер Codex.'));})
            .finally(() => {if (owns() && current === generation.current) setLoading(false);});
        return () => {generation.current++; cancellation.abort();};
    }, [model.id, model.revision, scope, reload, captureOwner]);
    return <Modal open centered className="model-details" title={`Codex: ${model.name}`} onCancel={onClose} footer={<Space wrap>
        <Button loading={loading} onClick={() => setReload(value => value + 1)}>Проверить компьютер</Button>
        <Button onClick={onClose}>Закрыть</Button>
    </Space>}>
        <Typography.Paragraph>Запросы чатов и агентов выполняются через выбранный компьютер. Вход Codex и ключи остаются на нём. Этим подключением пользуется владелец компьютера.</Typography.Paragraph>
        {loading && !connection && <Spin tip="Проверяем доступность компьютера…"/>}
        {error && <Alert type="error" showIcon message={error} className="model-catalog__notice"/>}
        {connection && <Space direction="vertical" className="model-opencode__source">
            <Descriptions column={1} size="small">
                <Descriptions.Item label="Компьютер">{connection.deviceName}</Descriptions.Item>
                <Descriptions.Item label="Источник">{connection.scope === 'project' ? 'Конфигурация проекта' : 'Общие настройки компьютера'}</Descriptions.Item>
            </Descriptions>
            <Alert showIcon type={error ? 'warning' : loading ? 'info' : connection.state === 'ready' ? 'success' : connection.state === 'error' ? 'error' : 'info'}
                message={loading || error ? 'Предыдущая проверка: актуальный статус не подтверждён' : connection.message}
                description={loading || error ? connection.message : undefined}/>
            <Typography.Text type="secondary">Эта проверка не обращается к модели. Чтобы проверить ответ Codex, откройте чат и отправьте сообщение.</Typography.Text>
            {onConfigureOpenCode && <Button onClick={() => onConfigureOpenCode(connection.deviceId)}>Настроить в OpenCode</Button>}
        </Space>}
    </Modal>;
}
