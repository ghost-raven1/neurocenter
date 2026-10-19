import { Button, Input, Space, Typography } from 'antd';
import { useId, useState, type FC } from 'react';
import { useHistory } from 'react-router-dom';

/** Возвращает к подтверждению установленного MCP, если ссылка из терминала была потеряна. */
export const PairingCode: FC = () => {
    const [code, setCode] = useState('');
    const history = useHistory();
    const id = useId();
    const valid = /^[A-F0-9]{16}$/.test(code);
    const review = (): void => {
        if (valid) {
            history.push('/projects?connect=' + encodeURIComponent(code));
        }
    };
    return <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text type="secondary">
            Этот способ нужен, если браузер не открыл страницу после установки.
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
