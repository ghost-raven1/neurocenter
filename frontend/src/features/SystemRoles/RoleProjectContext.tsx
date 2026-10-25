import { Typography } from 'antd';
import { roleName, type RoleProjectContextGrant, type RoleProjectContextReceipt, type RoleProjectContextSource } from './types';
import './RoleProjectContext.less';

/** The existing confirmation covers the whole approved index and its pinned recipients. */
export function RoleProjectContextPreview({ context }: { context?: RoleProjectContextGrant }): JSX.Element | null {
    if (!context) return <Typography.Paragraph type="secondary">Поиск по базе знаний в этот запуск не включён; обычный ответ доступен.</Typography.Paragraph>;
    return <div className="system-role-context" aria-label="Разрешение на поиск в базе знаний">
        <Typography.Paragraph>База знаний проекта «{context.projectName}»: поиск охватывает весь индекс проекта. Выбор целей ограничивает передачу их текстов и изменения; он не ограничивает пути в индексе.</Typography.Paragraph>
        <Typography.Paragraph>Фрагменты могут получить: {context.recipients.map(roleName).join(', ')}.</Typography.Paragraph>
        <Typography.Paragraph type="secondary">Не более одного поиска за запуск. Он входит в общий лимит вызовов модели и оставляет меньше шагов для ответов и исправлений. Найденные фрагменты станут известны после запуска.</Typography.Paragraph>
        {!context.snapshot && <Typography.Paragraph type="secondary">Полного снимка пока нет; роль ответит по доступным сведениям.</Typography.Paragraph>}
        <details><summary>Снимок разрешённого индекса</summary><div>Проект: {context.projectId}</div><div>Идентичность индекса: {context.identity}</div>
            {context.generation && <div>Поколение: {context.generation}</div>}{context.snapshot && <div>Снимок: {context.snapshot}</div>}</details>
    </div>;
}

function SourceLocation({ source }: { source: RoleProjectContextSource }): JSX.Element {
    return <span>{source.path}{source.startLine !== undefined && <> · {source.endLine !== undefined && source.endLine !== source.startLine ? `строки ${source.startLine}–${source.endLine}` : `строка ${source.startLine}`}</>}</span>;
}

/** A finding resolves only against the sources delivered to this particular answer. */
export function RoleFindingEvidence({ evidenceId, context, diagnosticIds = [] }: { evidenceId: string; context?: RoleProjectContextReceipt; diagnosticIds?: string[] }): JSX.Element {
    const source = context?.status === 'ready' ? context.sources.slice(0, 6).find(item => item.id === evidenceId) : undefined;
    return <Typography.Text type="secondary">{source ? <>Источник базы знаний: <SourceLocation source={source} /></> : <>{diagnosticIds.includes(evidenceId) ? 'ID измерения' : 'Основание (ID)'}: {evidenceId}</>}</Typography.Text>;
}

/** Only safe metadata is shown; provenance is readable without creating a URL from a source path. */
export function RoleProjectContextReceiptView({ context }: { context?: RoleProjectContextReceipt }): JSX.Element | null {
    if (!context) return null;
    const sources = context.status === 'ready' ? context.sources.slice(0, 6) : [];
    const status = context.status === 'ready' ? `передано источников: ${sources.length}` : context.status === 'empty' ? 'подходящих фрагментов нет' : context.status === 'unavailable' ? 'поиск недоступен' : 'фрагменты не переданы';
    return <section className="system-role-context" aria-label="База знаний в ответе">
        <Typography.Paragraph type="secondary">База знаний проекта «{context.project.name}»: {status}.</Typography.Paragraph>
        {context.message && <Typography.Paragraph type="secondary">{context.message}</Typography.Paragraph>}
        <details><summary>Источники базы знаний и снимок</summary><div>Проект: {context.project.id}</div>
            {context.generation && <div>Поколение: {context.generation}</div>}{context.snapshot && <div>Снимок: {context.snapshot}</div>}
            {!!sources.length && <ul>{sources.map(source => <li key={source.id}>{source.title && <div>{source.title}</div>}<SourceLocation source={source} /><div>ID источника: {source.id}</div></li>)}</ul>}
        </details>
    </section>;
}
