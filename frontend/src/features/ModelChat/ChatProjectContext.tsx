import {Typography} from 'antd';
import type {IChatProjectEvidence} from './types';

const labels: Record<IChatProjectEvidence['status'], string> = {
    none: 'Без контекста проекта', metadata: 'Сведения о проекте', ready: 'Контекст проекта подключён', empty: 'Совпадений в данных проекта нет', unavailable: 'Данные проекта недоступны',
};

/** Evidence belongs to the saved answer; source paths stay inert and never open arbitrary local URLs. */
export function ChatProjectContext({evidence, answer = false}: {evidence?: IChatProjectEvidence; answer?: boolean}): JSX.Element | null {
    if (!evidence || evidence.status === 'none') return null;
    return <details className="model-chat__project-context">
        <summary><Typography.Text type={evidence.status === 'unavailable' ? 'warning' : 'secondary'}>{answer && evidence.sources.length ? `Источники · ${evidence.sources.length}` : labels[evidence.status]}</Typography.Text></summary>
        <div className="model-chat__project-context-body">
            {evidence.project && <Typography.Text strong>{evidence.project.name}</Typography.Text>}
            {evidence.message && <p>{evidence.message}</p>}
            {!answer && evidence.status !== 'metadata' && <p>Доступные данные проекта подбираются к сообщению. Источники, использованные для ответа, будут показаны под ним.</p>}
            {answer && evidence.status === 'ready' && !evidence.sources.length && <p>Сервер не передал список источников для этого ответа.</p>}
            {answer && evidence.sources.length > 0 && <ol>{evidence.sources.map(source => <li key={source.id}>
                <Typography.Text strong>{source.title || source.path}</Typography.Text>
                <Typography.Text type="secondary" className="model-chat__source-path">{source.path}{source.startLine != null ? `:${source.startLine}${source.endLine != null && source.endLine !== source.startLine ? `–${source.endLine}` : ''}` : ''}</Typography.Text>
                <blockquote>{source.excerpt}</blockquote>
            </li>)}</ol>}
        </div>
    </details>;
}
