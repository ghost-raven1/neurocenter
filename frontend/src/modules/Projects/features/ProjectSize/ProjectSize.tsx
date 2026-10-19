import { Button, Statistic } from 'antd';
import { formatBytes } from '../../../../common/utils/format';
import './ProjectSize.less';

interface IProjectSizeProps {
    kind: 'logical' | 'retained';
    bytes: unknown;
    error?: string;
    title?: string;
    loading: boolean;
    onRetry: () => void;
}

/** Не превращает отсутствие измерения в пустой проект или пустую копию знаний. */
export function ProjectSize({ kind, bytes, error, title, loading, onRetry }: IProjectSizeProps) {
    const known = typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0;
    const label = known ? bytes < 1000 ? `${bytes} Б` : formatBytes(bytes) : 'Недоступно';
    const fallback = kind === 'logical'
        ? 'Не удалось измерить данные проекта. Повторите попытку.'
        : 'Не удалось измерить копию знаний. Повторите попытку.';
    const retryLabel = kind === 'logical' ? 'Повторить измерение данных проекта' : 'Повторить измерение копии знаний';

    return <div className="project-size">
        {title ? <Statistic title={title} value={label} /> : <span>{label}</span>}
        {!known && <div className="project-size__unavailable">
            <span>{typeof error === 'string' && error.trim() ? error : fallback}</span>
            <Button type="link" size="small" loading={loading} aria-label={retryLabel}
                onClick={event => { event.stopPropagation(); onRetry(); }}>Повторить</Button>
        </div>}
    </div>;
}
