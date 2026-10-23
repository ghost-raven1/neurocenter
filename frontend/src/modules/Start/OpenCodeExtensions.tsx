import { ArrowRightOutlined } from '@ant-design/icons';
import { Button, Card, Modal, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useHistory, useLocation } from 'react-router-dom';

const { Title, Paragraph } = Typography;
const extensions = [
    { id: 'rag', title: 'Поиск по проекту', name: 'OpenCodeRAG', kind: 'Плагин', description: 'Плагин MrDoe: поиск по смыслу, индексация и обработчики OpenCode.', catalog: `/store?q=${encodeURIComponent('OpenCodeRAG (плагин)')}` },
    { id: 'snip', title: 'Короткие ответы терминала', name: 'opencode-snip', kind: 'Плагин', description: 'Фильтрация вывода команд: меньше шума в контексте агента.', catalog: '/store?q=opencode-snip' },
];

/** Предпросмотр подключения расширений не подменяет их установку и проверку. */
const OpenCodeExtensions = ({ project }: { project?: string }) => {
    const history = useHistory();
    const location = useLocation();
    const requested = new URLSearchParams(location.search).get('extension');
    const catalogLink = (catalog: string): string => project ? `${catalog}&p=${encodeURIComponent(project)}` : catalog;
    const [selected, setSelected] = useState<(typeof extensions)[number] | null>(() => extensions.find(extension => extension.id === requested) ?? null);
    useEffect(() => {
        if (requested === 'lsp') {history.replace('/help/opencode-lsp'); return;}
        setSelected(extensions.find(extension => extension.id === requested) ?? null);
    }, [requested, history]);
    const close = (): void => {
        setSelected(null);
        if (!requested) { return; }
        const params = new URLSearchParams(location.search);
        params.delete('extension');
        const search = params.toString();
        history.replace(`${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
    };

    return (
        <section className="start__extensions" aria-labelledby="opencode-extensions-title">
            <Title level={3} id="opencode-extensions-title">Расширения OpenCode</Title>
            <Paragraph type="secondary">MCP и плагины устанавливаются из каталога через мост. <Typography.Link href="/help/opencode-lsp">Работа с кодом: LSP — в Помощи</Typography.Link>.</Paragraph>
            <div className="start__guides">
                {extensions.map(extension => <Card key={extension.name} size="small">
                    <div className="start__extension-kind"><Tag>{extension.kind}</Tag><Typography.Text type="secondary">{extension.name}</Typography.Text></div>
                    <Title level={4}>{extension.title}</Title>
                    <Paragraph type="secondary">{extension.description}</Paragraph>
                    <Button type="link" icon={<ArrowRightOutlined />} href={catalogLink(extension.catalog)}>Открыть в каталоге</Button>
                </Card>)}
            </div>
            <Modal
                title={selected ? `${selected.title} · ${selected.name}` : 'Подключение расширения'}
                open={!!selected} onCancel={close} width={860} destroyOnClose
                className="extension-instruction" footer={<Space wrap>
                    <Button onClick={close}>Закрыть</Button>
                    {selected?.id === 'rag' && project && <Button href={`/projects/${encodeURIComponent(project)}?tab=rag`}>Вернуться к знаниям</Button>}
                    {selected && <Button type="primary" icon={<ArrowRightOutlined />} href={catalogLink(selected.catalog)}>Открыть в каталоге</Button>}
                </Space>}
            >
                {selected && <>
                    <Paragraph>Выберите проект и установите {selected.name} через мост из карточки каталога.</Paragraph>
                    <Paragraph type="secondary">Каталог покажет состав готового комплекта, поддерживаемые платформы и разрешение на выбранную версию. После установки запуск проверяется отдельно.</Paragraph>
                    {selected.id === 'rag' && <>
                        <Paragraph>После установки подготовьте модель и индекс в той же связанной папке проекта:</Paragraph>
                        <ol>
                            <li>В «Базе знаний» выберите модель проекта и подключите её к нужной установке OpenCodeRAG. Для серверной модели автоматическая индексация отключена.</li>
                            <li>Откройте интерфейс выбранной установки и явно запустите полное индексирование. Перезапустите OpenCode, чтобы он прочитал подключение.</li>
                            <li>После завершения индексирования вернитесь в «Базу знаний» и нажмите «Синхронизировать с сервером».</li>
                        </ol>
                        <Paragraph type="secondary">Существующий opencode-rag.json сохраняется. Если используете локальную модель, проверьте её сервис и адрес в настройках проекта; для нового проекта с локальной моделью автоматическая индексация включена по умолчанию. Установка плагина не скачивает веса модели. Подключение серверной модели само не перестраивает индекс.</Paragraph>
                    </>}
                </>}
            </Modal>
        </section>
    );
};

export default OpenCodeExtensions;
