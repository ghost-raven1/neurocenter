import { Alert, Button } from 'antd';
import { toolCatalogSources, type ToolCatalogSource, type ToolCatalogState } from './toolCatalogController';

const names = { plugins: 'MCP и плагины', skills: 'скиллы' };
const retryNames = { plugins: 'MCP и плагинов', skills: 'скиллов' };

/** Состояние и повтор принадлежат одному источнику; остальные карточки доступны сразу. */
export function ToolCatalogStatus({ sources, refresh }: { sources: ToolCatalogState; refresh(source: ToolCatalogSource): Promise<void> }): JSX.Element {
    return <>{toolCatalogSources.map(source => {
        const state = sources[source];
        if (state.error) return <Alert key={source} type={state.ready ? 'warning' : 'error'} showIcon style={{ marginBottom: 16 }}
            message={`Не удалось загрузить ${names[source]}`} description={<>{state.ready && 'Показаны предыдущие данные. '}{state.error}</>}
            action={<Button size="small" loading={state.loading} onClick={() => { void refresh(source); }}>Повторить загрузку {retryNames[source]}</Button>} />;
        return state.loading ? <div key={source} role="status" style={{ marginBottom: 12 }}>{source === 'skills' ? 'Загружаем скиллы…' : 'Загружаем MCP и плагины…'}</div> : null;
    })}</>;
}
