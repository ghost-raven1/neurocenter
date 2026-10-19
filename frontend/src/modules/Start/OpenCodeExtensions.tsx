import { ArrowRightOutlined, CopyOutlined, ReadOutlined } from '@ant-design/icons';
import { Button, Card, Modal, Space, Tag, Typography, message } from 'antd';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useHistory, useLocation } from 'react-router-dom';

import lspDoc from './docs/OPENCODE-LSP.md?raw';

const ExtensionInstruction = lazy(() => import('./ExtensionInstruction'));
const { Title, Paragraph } = Typography;
const extensions = [
    { id: 'lsp', title: 'Работа с кодом', name: 'LSP', kind: 'Встроено в OpenCode', description: 'Навигация по файлам и символам, диагностика кода в OpenCode.', content: lspDoc, catalog: null },
    { id: 'rag', title: 'Поиск по проекту', name: 'OpenCodeRAG', kind: 'Плагин', description: 'Плагин MrDoe: поиск по смыслу, индексация и обработчики OpenCode.', content: null, catalog: `/store?q=${encodeURIComponent('OpenCodeRAG (плагин)')}` },
    { id: 'snip', title: 'Короткие ответы терминала', name: 'opencode-snip', kind: 'Плагин', description: 'Фильтрация вывода команд: меньше шума в контексте агента.', content: null, catalog: '/store?q=opencode-snip' },
];

/** Предпросмотр подключения расширений не подменяет их установку и проверку. */
const OpenCodeExtensions = ({ project }: { project?: string }) => {
    const history = useHistory();
    const location = useLocation();
    const requested = new URLSearchParams(location.search).get('extension');
    const catalogLink = (catalog: string): string => project ? `${catalog}&p=${encodeURIComponent(project)}` : catalog;
    const [selected, setSelected] = useState<(typeof extensions)[number] | null>(() => extensions.find(extension => extension.id === requested) ?? null);
    useEffect(() => { setSelected(extensions.find(extension => extension.id === requested) ?? null); }, [requested]);
    const close = (): void => {
        setSelected(null);
        if (!requested) { return; }
        const params = new URLSearchParams(location.search);
        params.delete('extension');
        const search = params.toString();
        history.replace(`${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
    };
    const copy = async (): Promise<void> => {
        if (!selected?.content) { return; }
        try {
            await navigator.clipboard.writeText(selected.content);
            void message.success('Инструкция скопирована. Передайте её агенту OpenCode.');
        } catch {
            void message.error('Не удалось скопировать. Выделите текст инструкции и скопируйте вручную.');
        }
    };

    return (
        <section className="start__extensions" aria-labelledby="opencode-extensions-title">
            <Title level={3} id="opencode-extensions-title">Расширения OpenCode</Title>
            <Paragraph type="secondary">MCP и плагины устанавливаются из каталога через мост. Для встроенного LSP доступна справка.</Paragraph>
            <div className="start__guides">
                {extensions.map(extension => <Card key={extension.name} size="small">
                    <div className="start__extension-kind"><Tag>{extension.kind}</Tag><Typography.Text type="secondary">{extension.name}</Typography.Text></div>
                    <Title level={4}>{extension.title}</Title>
                    <Paragraph type="secondary">{extension.description}</Paragraph>
                    {extension.catalog
                        ? <Button type="link" icon={<ArrowRightOutlined />} href={catalogLink(extension.catalog)}>Открыть в каталоге</Button>
                        : <Button type="link" icon={<ReadOutlined />} onClick={() => setSelected(extension)}>Как пользоваться</Button>}
                </Card>)}
            </div>
            <Modal
                title={selected ? `${selected.title} · ${selected.name}` : 'Подключение расширения'}
                open={!!selected} onCancel={close} width={860} destroyOnClose
                className="extension-instruction" footer={<Space wrap>
                    <Button onClick={close}>Закрыть</Button>
                    {selected?.id === 'rag' && project && <Button href={`/projects/${encodeURIComponent(project)}?tab=rag`}>Вернуться к знаниям</Button>}
                    {selected?.catalog
                        ? <Button type="primary" icon={<ArrowRightOutlined />} href={catalogLink(selected.catalog)}>Открыть в каталоге</Button>
                        : <Button type="primary" icon={<CopyOutlined />} onClick={() => { void copy(); }}>Копировать для агента</Button>}
                </Space>}
            >
                {selected?.catalog ? <>
                    <Paragraph>Выберите проект и установите {selected.name} через мост из карточки каталога.</Paragraph>
                    <Paragraph type="secondary">Каталог покажет состав готового комплекта, поддерживаемые платформы и разрешение на выбранную версию. После установки запуск проверяется отдельно.</Paragraph>
                    {selected.id === 'rag' && <>
                        <Paragraph>После установки откройте OpenCode в той же связанной папке проекта:</Paragraph>
                        <ol>
                            <li>Убедитесь, что сервис эмбеддингов доступен. По умолчанию используется локальная модель qwen3-embedding:4b на http://127.0.0.1:11435/api.</li>
                            <li>Перезапустите OpenCode. Плагин подключит свои инструменты и обработчики. Если конфигурации проекта нет, автоматическая индексация включена.</li>
                            <li>Вернитесь в «Базу знаний» этого проекта и нажмите «Синхронизировать с сервером».</li>
                        </ol>
                        <Paragraph type="secondary">Существующий opencode-rag.json сохраняется. Модель запускается отдельно; установка плагина не скачивает её веса. Адаптер MCP в каталоге — отдельный инструмент со своим локальным мастером настройки.</Paragraph>
                    </>}
                </> : <Paragraph type="secondary">LSP встроен в OpenCode. Справка поможет проверить поддержку языка и настроить языковой сервер для проекта.</Paragraph>}
                {selected?.content && <Suspense fallback={<Paragraph>Загружаем инструкцию…</Paragraph>}>
                    <ExtensionInstruction content={selected.content} />
                </Suspense>}
            </Modal>
        </section>
    );
};

export default OpenCodeExtensions;
