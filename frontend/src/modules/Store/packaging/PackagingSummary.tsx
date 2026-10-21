import { Typography } from 'antd';
import type { PackagingKind } from './types';

interface Props { name: string; description: string; kind: PackagingKind; entrypoint?: string; }

/** Перед отправкой показывает будущую карточку и отделяет публикацию от установки в проект. */
export function PackagingSummary({ name, description, kind, entrypoint }: Props) {
    return <section className="tool-packaging__summary" aria-label="Будет добавлено в каталог">
        <Typography.Text type="secondary" className="tool-packaging__summary-label">Будет добавлено в общий каталог</Typography.Text>
        <div className="tool-packaging__summary-heading"><Typography.Text strong>{name}</Typography.Text><span className="tool-packaging__kind">{kind === 'mcp' ? 'MCP-сервер' : kind === 'skill' ? 'Скилл' : 'Плагин OpenCode'}</span></div>
        {description && <Typography.Paragraph className="tool-packaging__summary-description">{description}</Typography.Paragraph>}
        {entrypoint && <Typography.Text type="secondary">{kind === 'skill' ? 'Инструкция определена' : 'Файл запуска определён'}: {entrypoint}</Typography.Text>}
        <Typography.Text type="secondary">Установка в проект — следующий шаг из карточки инструмента.</Typography.Text>
    </section>;
}
