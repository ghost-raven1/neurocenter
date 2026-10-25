import {Space, Typography} from 'antd';
import {SafeMarkdown, safeMarkdownUrl} from '../Discussions/SafeMarkdown';
import type {RoleResult} from './types';

/** The human answer stays visible; measured source metadata is available on demand. */
export function RoleAnswer({result}: {result: RoleResult}): JSX.Element {
    return <>{result.answer ? <SafeMarkdown body={result.answer} /> : <Typography.Paragraph>{result.summary}</Typography.Paragraph>}
        {!!result.actions?.length && <Space wrap aria-label="Следующие действия">{result.actions.filter(action => action.path.startsWith('/') && !action.path.startsWith('//') && safeMarkdownUrl(action.path)).map(action =>
            <a className="ant-btn ant-btn-default" key={action.id} href={action.path}>{action.label}{action.requiresPermission ? ' · нужен доступ' : ''}</a>)}</Space>}
        {result.guidance && <section aria-label="Источники справки и диагностики">{result.guidance.message && <Typography.Paragraph type="secondary">{result.guidance.message}</Typography.Paragraph>}
            <details><summary>Проверенные источники · {new Date(result.guidance.checkedAt).toLocaleString('ru-RU')}</summary>
                {result.guidance.status === 'unavailable' && <Typography.Paragraph>Дополнительные проверки недоступны. Агент должен учитывать это ограничение в ответе.</Typography.Paragraph>}
                <ul>{result.guidance.sources.map(source => <li key={source.id}>{source.kind === 'help' && source.slug && /^[a-z0-9][a-z0-9-]{0,79}$/.test(source.slug)
                    ? <a href={'/help/' + encodeURIComponent(source.slug)}>{source.title}</a> : source.title}
                    <div>{source.id}{source.revision && <> · версия {source.revision}</>}</div></li>)}</ul>
            </details>
        </section>}</>;
}
