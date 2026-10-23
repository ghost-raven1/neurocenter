import { Alert, Button, Card, Typography } from 'antd';
import { ArrowRightOutlined } from '@ant-design/icons';
import type { FC } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { authLoginBlitz } from './redux/actions';
import { LoginBackdrop } from './LoginBackdrop';
import './LoginScreen.less';

/** The existing Blitz sign-in keeps its loading/error state inside a quiet entry screen. */
const LoginScreen: FC = () => {
    const { processing, error } = useSelector((state: RootState) => state.userBlock);
    return <main className="app__login login-screen">
        <LoginBackdrop/>
        <div className="login-screen__shell">
            <div className="login-screen__brand">
                <span className="login-screen__mark" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><path d="M11 11v18m0-18 18 18m0-18v18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><circle cx="11" cy="11" r="3" fill="currentColor"/><circle cx="29" cy="11" r="3" fill="currentColor"/><circle cx="11" cy="29" r="3" fill="currentColor"/><circle cx="29" cy="29" r="3" fill="currentColor"/></svg></span>
                <Typography.Text strong>Нейроцентр</Typography.Text>
            </div>
            <div className="login-screen__content">
                <section className="login-screen__hero" aria-labelledby="login-title">
                    <span className="login-screen__eyebrow">Пространство вашей команды</span>
                    <Typography.Title id="login-title" level={1}>Идеи становятся<br/><span>общим знанием.</span></Typography.Title>
                    <Typography.Paragraph>Ваши проекты, инструменты и знания команды — в одном рабочем пространстве.</Typography.Paragraph>
                    <div className="login-screen__features" aria-label="Возможности рабочего пространства"><span>Проекты</span><i aria-hidden="true"/><span>Инструменты</span><i aria-hidden="true"/><span>База знаний</span></div>
                </section>
                <Card className="app__login-card login-screen__card" bordered={false}>
                    <span className="login-screen__card-kicker">Добро пожаловать</span>
                    <Typography.Title level={2}>Вход в Нейроцентр</Typography.Title>
                    <Typography.Paragraph type="secondary">Продолжите с учётной записью вашей команды.</Typography.Paragraph>
                    {error&&<Alert className="login-screen__error" role="alert" type="error" showIcon message={error}/>}
                    <Button type="primary" block loading={processing} size="large" onClick={authLoginBlitz} icon={!processing?<ArrowRightOutlined/>:undefined}>Войти в Нейроцентр</Button>
                    <Typography.Text type="secondary" className="login-screen__hint">Вы перейдёте на страницу входа организации.</Typography.Text>
                </Card>
            </div>
            <div className="login-screen__footer">Одно пространство. Вся команда.</div>
        </div>
    </main>;
};
export default LoginScreen;
