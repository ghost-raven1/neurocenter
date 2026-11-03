import { Select } from 'antd';
import { FC, useMemo } from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { useAvailableProjects } from '../Projects/hooks/useAvailableProjects';
import './ProjectTargetSelect.less';

/**
 * Глобальный селектор «Каталог проекта» в шапке рабочего пространства.
 * Управляет общим параметром ?p (магазин, чат, «Начало работы»); выбор
 * сохраняется вместе с последней страницей магазина. Скрыт, пока нет проектов.
 */
export const ProjectTargetSelect: FC = () => {
    const history = useHistory();
    const location = useLocation();
    const { projects, ready, loading } = useAvailableProjects();
    const requested = new URLSearchParams(location.search).get('p');
    const selected = requested && projects.some((project) => project.id === requested) ? requested : undefined;
    const options = useMemo(() => projects.map((project) => ({ value: project.id, label: project.name })), [projects]);

    if (!ready || projects.length === 0) {
        return null;
    }

    const change = (value: string | null): void => {
        const params = new URLSearchParams(location.search);
        if (value) {
            params.set('p', value);
            try {
                localStorage.setItem('neurocenter.install-project', value);
            } catch {
                /* Хранилище браузера может быть недоступно. */
            }
        } else {
            params.delete('p');
            try {
                localStorage.removeItem('neurocenter.install-project');
            } catch {
                /* Хранилище браузера может быть недоступно. */
            }
        }
        history.replace(location.pathname + (params.size ? `?${params}` : '') + location.hash);
    };

    return (
        <Select
            className="project-target"
            aria-label="Каталог проекта"
            placeholder="Проект не выбран"
            value={selected}
            loading={loading}
            allowClear
            showSearch
            optionFilterProp="label"
            options={options}
            onChange={(value) => change(value ?? null)}
            style={{ width: '100%' }}
        />
    );
};
