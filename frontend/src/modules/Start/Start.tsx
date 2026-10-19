import { ApiOutlined, ArrowRightOutlined, CheckCircleOutlined, CopyOutlined, FolderOpenOutlined, RocketOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Collapse, Select, Skeleton, Space, Steps, Typography, message } from 'antd';
import { useEffect } from 'react';
import { useHistory, useLocation } from 'react-router-dom';

import { CodeBlock } from '../../common/components/CodeBlock';
import { PageHeading } from '../../common/components/PageHeading';
import { useAvailableProjects } from '../Projects/useAvailableProjects';
import installDoc from './docs/OPENCODE-INSTALL.md?raw';
import OpenCodeExtensions from './OpenCodeExtensions';
import './Start.less';
import {BridgeSetup} from './BridgeSetup';
import { startQueryUrl, startStep } from './startQuery';

const { Title, Text, Paragraph } = Typography;

/** Копирует готовую команду; установка остаётся явным действием пользователя в терминале. */
async function copy(text: string, instruction = false): Promise<void> {
    try { await navigator.clipboard.writeText(text); message.success(instruction ? 'Инструкция скопирована. Передайте её агенту OpenCode.' : 'Команда скопирована. Вставьте её в терминал.'); }
    catch { message.error('Не удалось скопировать текст. Выделите его и скопируйте вручную.'); }
}

/** Короткий первый запуск: установка, подключение и переход к инструментам выбранного проекта. */
const Start = () => {
    const history = useHistory();
    const location = useLocation();
    const step = startStep(location.search);
    const { projects, ready, loading, error, refresh } = useAvailableProjects();
    const requestedProject = new URLSearchParams(location.search).get('p');
    const project = ready ? projects.find(item => item.id === requestedProject || item.name === requestedProject)?.name : undefined;
    const go = (next: number): void => history.replace(startQueryUrl(location.search, { step: next }, location.hash));
    const selectProject = (value: string): void => history.replace(startQueryUrl(location.search, { project: value }, location.hash));
    const bridgeBase = `${window.location.origin}/api/bridge`;
    const windows = /Windows/i.test(navigator.userAgent);
    const installCommand = windows
        ? `irm ${bridgeBase}/install_opencode.ps1 | iex`
        : `curl -fsSL ${bridgeBase}/install_opencode.sh | bash`;
    const instructions = installDoc.replace(/__BRIDGE_BASE__/g, bridgeBase);

    useEffect(() => {
        if (!ready || error || requestedProject || projects.length !== 1) { return; }
        history.replace(startQueryUrl(location.search, { project: projects[0].name }, location.hash));
    }, [ready, error, requestedProject, projects, history, location.search, location.hash]);

    return (
        <div className="start">
            <PageHeading title="Начало работы" description="Подключите рабочее окружение один раз. Затем добавляйте инструменты в проекты прямо из каталога." actions={<Button onClick={() => history.push('/projects')}>Мои проекты <ArrowRightOutlined /></Button>} />
            <Card className="start__setup">
                <div role="group" aria-label="Этапы подключения" onKeyDown={event => {
                    if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLElement && event.target.getAttribute('role') === 'button') {
                        event.preventDefault(); event.target.click();
                    }
                }}>
                    <Steps current={step} onChange={go} size="small" responsive={false} labelPlacement="vertical" items={[
                        { title: 'OpenCode', icon: <RocketOutlined /> },
                        { title: 'Компьютер', icon: <ApiOutlined /> },
                        { title: 'Проект', icon: <CheckCircleOutlined /> },
                    ]} />
                </div>
                <div className="start__step">
                    {step === 0 && <>
                        <Title level={3}>Начните с ИИ-помощника</Title>
                        <Paragraph type="secondary">Скопируйте команду и выполните её в терминале. Если OpenCode уже установлен, переходите к подключению.</Paragraph>
                        <div className="start__command"><code>{installCommand}</code><Button icon={<CopyOutlined />} onClick={() => { void copy(installCommand); }}>Копировать команду</Button></div>
                        <Paragraph type="secondary">Установщик сам определит систему и архитектуру. Поддерживаются macOS, Linux и Windows (PowerShell, WSL или Git Bash). Готовые пакеты скачиваются с этой площадки.</Paragraph>
                        <Button type="primary" onClick={() => go(1)}>Продолжить <ArrowRightOutlined /></Button>
                        <Collapse ghost><Collapse.Panel key="manual" header="Подробная инструкция по установке"><Button icon={<CopyOutlined />} onClick={() => { void copy(instructions, true); }}>Копировать инструкцию</Button><CodeBlock code={instructions} language="markdown" theme="dark" style={{maxHeight:320,overflow:'auto',marginTop:16}} /></Collapse.Panel></Collapse>
                    </>}
                    {step === 1 && <>
                        <BridgeSetup origin={window.location.origin} windows={windows} onCopy={text=>{void copy(text);}}/>
                        <Space wrap style={{marginTop:16}}><Button onClick={() => go(0)}>Назад</Button><Button onClick={() => go(2)}>Папка и проект <ArrowRightOutlined /></Button></Space>
                    </>}
                    {step === 2 && <>
                        <Title level={3}>Свяжите папку с проектом</Title>
                        <Paragraph type="secondary">На странице «Проекты» выберите общую папку на своём компьютере и свяжите нужный подкаталог с серверным проектом. Названия папок и проектов могут отличаться.</Paragraph>
                        <Button type="primary" onClick={()=>history.push('/projects')}>Выбрать папку и связать проект <ArrowRightOutlined/></Button>
                        <Paragraph type="secondary" style={{marginTop:16}}>Когда привязка готова, выберите проект ниже и откройте его каталог инструментов.</Paragraph>
                        {error && <Alert type="error" showIcon message="Не удалось загрузить проекты" description={error} action={<Button size="small" onClick={() => { void refresh(); }}>Повторить</Button>} />}
                        {loading && !ready ? <Skeleton active paragraph={{rows:2}} /> : <Space direction="vertical" size={16} style={{width:'100%'}}>
                            <Select aria-label="Проект для настройки" showSearch optionFilterProp="label" placeholder="Выберите проект" value={project} onChange={selectProject} disabled={!ready || !!error} style={{width:'100%',maxWidth:420}} options={projects.map(item => ({value:item.name,label:item.name}))} notFoundContent={error ? 'Список проектов недоступен' : 'Сначала создайте или подключите проект'} />
                            <Button type="primary" disabled={!project || !!error} onClick={() => history.push(`/store?p=${encodeURIComponent(project ?? '')}`)}>Подобрать инструменты <ArrowRightOutlined /></Button>
                        </Space>}
                    </>}
                </div>
            </Card>
            <section className="start__hero">
                <div><Text className="start__eyebrow">ВАШЕ РАБОЧЕЕ ПРОСТРАНСТВО</Text><Title level={2}>От идеи — к работе.<br />Всё для команды в одном месте.</Title><Paragraph>Скиллы, MCP и плагины дополняют вашего ИИ-помощника. Базы знаний помогают ему понимать ваш проект.</Paragraph><Button type="primary" size="large" onClick={() => history.push('/store')}>Открыть каталог <ArrowRightOutlined /></Button></div>
                <div className="start__overview"><FolderOpenOutlined /><strong>{ready ? projects.length : loading ? '…' : '—'}</strong><Text>проектов в рабочем пространстве</Text><span>Выберите проект и соберите свой набор инструментов.</span></div>
            </section>
            <OpenCodeExtensions project={project} />
        </div>
    );
};

export default Start;
