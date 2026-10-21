import { ApiOutlined, ArrowRightOutlined, CopyOutlined, FolderOpenOutlined, RocketOutlined } from '@ant-design/icons';
import { Button, Card, Collapse, Space, Steps, Typography, message } from 'antd';
import { useEffect } from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import {useSelector} from 'react-redux';

import { CodeBlock } from '../../common/components/CodeBlock';
import { PageHeading } from '../../common/components/PageHeading';
import { useAvailableProjects } from '../Projects/useAvailableProjects';
import installDoc from './docs/OPENCODE-INSTALL.md?raw';
import OpenCodeExtensions from './OpenCodeExtensions';
import './Start.less';
import {BridgeSetup} from './BridgeSetup';
import { startQueryUrl, startStep } from './startQuery';
import {StartProjectStep} from './StartProjectStep';
import {useBridgeInstaller} from '../../features/McpBridge/useBridgeInstaller';
import {BridgeInstallerCommand} from '../../features/McpBridge/BridgeInstallerCommand';
import {openCodeInstallerCommand} from '../../features/McpBridge/connectionCommands';
import {isMainAdminRole} from '../../features/UserBlock/roles';
import type {RootState} from '../../store';

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
    const selectedProject = ready && !error
        ? projects.find(item => item.id === requestedProject) ?? projects.find(item => item.name === requestedProject)
        : undefined;
    const project = selectedProject?.name;
    const go = (next: number): void => history.replace(startQueryUrl(location.search, { step: next }, location.hash));
    const selectProject = (value: string): void => history.replace(startQueryUrl(location.search, { project: value }, location.hash));
    const installer=useBridgeInstaller(step<2);
    const canManageBridgeSource=useSelector((state:RootState)=>!!state.userBlock.user&&state.userBlock.user.userRoles.includes(state.userBlock.user.activeRole)&&isMainAdminRole(state.userBlock.user.activeRole));
    const windows = /Windows/i.test(navigator.userAgent);
    const instructions = installer.origin?installDoc
        .replace('__INSTALL_POSIX__',()=>openCodeInstallerCommand(installer.origin!,false))
        .replace('__INSTALL_WINDOWS__',()=>openCodeInstallerCommand(installer.origin!,true)):'';

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
                        { title: 'Проект', icon: <FolderOpenOutlined /> },
                    ]} />
                </div>
                <div className="start__step">
                    {step === 0 && <>
                        <Title level={3}>Начните с ИИ-помощника</Title>
                        <Paragraph type="secondary">Скопируйте команду и выполните её в терминале. Если OpenCode уже установлен, переходите к подключению.</Paragraph>
                        <BridgeInstallerCommand installer={installer} windows={windows} openCode onCopy={text=>{void copy(text);}}/>
                        <Paragraph type="secondary">Установщик сам определит систему и архитектуру. Поддерживаются macOS, Linux и Windows (PowerShell, WSL или Git Bash). Готовые пакеты скачиваются с этой площадки.</Paragraph>
                        <Button type="primary" onClick={() => go(1)}>Продолжить <ArrowRightOutlined /></Button>
                        {installer.origin&&<Collapse ghost><Collapse.Panel key="manual" header="Подробная инструкция по установке"><Button icon={<CopyOutlined />} onClick={() => { void copy(instructions, true); }}>Копировать инструкцию</Button><CodeBlock code={instructions} language="markdown" theme="dark" style={{maxHeight:320,overflow:'auto',marginTop:16}} /></Collapse.Panel></Collapse>}
                    </>}
                    {step === 1 && <>
                        <BridgeSetup origin={window.location.origin} installer={installer} windows={windows} projectId={selectedProject?.id} canManageSource={canManageBridgeSource} onCopy={text=>{void copy(text);}}/>
                        <Space wrap style={{marginTop:16}}><Button onClick={() => go(0)}>Назад</Button><Button onClick={() => go(2)}>Папка и проект <ArrowRightOutlined /></Button></Space>
                    </>}
                    {step === 2 && <StartProjectStep projects={projects} ready={ready} loading={loading} error={error} requestedProject={requestedProject} selectedProject={selectedProject} refresh={refresh} onSelect={selectProject} onBack={()=>go(1)}/>}
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
