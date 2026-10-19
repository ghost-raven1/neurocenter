import { Button, Card, Typography } from 'antd';
import block from 'bem-cn';
import { FC } from 'react';
import { useSelector } from 'react-redux';

import { RootState } from '../../store';
import { DeploymentUnitOutlined } from '@ant-design/icons';
import { authLoginBlitz } from './redux/actions';

const b = block('app');
const { Title, Paragraph } = Typography;

/**
 * Экран входа: при отсутствии сессии предлагает войти через Blitz.
 *
 * @component
 * @returns JSX-элемент экрана входа
 */
const LoginScreen: FC = () => {
    const { processing, error } = useSelector((state: RootState) => state.userBlock);

    return (
        <div className={b('login').toString()}>
            <Card className={b('login-card').toString()}>
                <DeploymentUnitOutlined className="app__login-mark" />
                <Title level={2}>Нейроцентр</Title>
                <Paragraph type="secondary">
                    Ваши проекты, инструменты и знания команды — в одном рабочем пространстве.
                </Paragraph>
                {error ? <Paragraph type="danger">{error}</Paragraph> : null}
                <Button type="primary" block loading={processing} size="large" onClick={authLoginBlitz}>
                    Войти в Нейроцентр
                </Button>
            </Card>
        </div>
    );
};

export default LoginScreen;
