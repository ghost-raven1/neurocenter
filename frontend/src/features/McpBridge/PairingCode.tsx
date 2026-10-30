import { Button, Input, Space, Typography } from 'antd';
import { useId, useState, type FC } from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import {startQueryUrl} from '../../modules/Start/startQuery';

/** Возвращает к подтверждению установленного MCP, если ссылка из терминала была потеряна. */
export const PairingCode: FC = () => {
    const [code, setCode] = useState('');
    const history = useHistory();
    const location = useLocation();
    const id = useId();
    const valid = /^[A-F0-9]{16}$/.test(code);
    const review = (): void => {
        if (valid) {
            const params = new URLSearchParams(location.search);
            params.set('connect', code);
            history.push(startQueryUrl(params.toString(), {setup: true, step: 0}, location.hash));
        }
    };
    return <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text type="secondary">
            Этот способ нужен, если у вас уже есть код подключения или браузер не открыл страницу подтверждения.
            Вставьте код из терминала, проверьте имя компьютера и подтвердите доступ. Код действует 10 минут.
        </Typography.Text>
        <label htmlFor={id}>Или введите код подключения из терминала</label>
        <Space wrap>
            <Input id={id} value={code} placeholder="16 символов" maxLength={32}
                autoComplete="off" spellCheck={false} style={{ width: 210 }}
                onChange={event => setCode(event.target.value.trim().toUpperCase())}
                onPressEnter={review} />
            <Button disabled={!valid} onClick={review}>Проверить компьютер</Button>
        </Space>
    </Space>;
};
