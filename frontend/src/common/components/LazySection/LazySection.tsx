import { Button, Result, Spin, Typography } from 'antd';
import { Component, lazy, Suspense } from 'react';
import type { ComponentType, FC, ReactNode } from 'react';
import { useSelector } from 'react-redux';
import { useLocation } from 'react-router-dom';

import { authDataScope } from '../../../features/UserBlock/authDataScope';
import type { RootState } from '../../../store';
import './LazySection.less';

interface IBoundaryProps { children: ReactNode; reload: () => void; }

/** Ошибка загрузки раздела оставляет навигацию доступной и предлагает явный повтор. */
export class LazySectionBoundary extends Component<IBoundaryProps, { failed: boolean }> {
    public state = { failed: false };
    public static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
    public render(): ReactNode {
        if (!this.state.failed) { return this.props.children; }
        return <Result status="warning" title="Не удалось открыть раздел"
            subTitle="Проверьте соединение и перезагрузите страницу. Текущий адрес сохранится."
            extra={<Button type="primary" onClick={this.props.reload}>Перезагрузить страницу</Button>} />;
    }
}

/** Загружает раздел только при отображении; смена владельца или пути снимает прежнее состояние. */
export function lazySection(
    load: () => Promise<{ default: ComponentType }>,
    title: string,
    options: { preserveOnNavigation?: boolean } = {},
): FC {
    const Section = lazy(load);
    const LazySection: FC = () => {
        const { pathname } = useLocation();
        const scope = useSelector((state: RootState) => {
            const { user, policies } = state.userBlock;
            return user ? authDataScope({ user, policies }) : '';
        });
        return <LazySectionBoundary key={JSON.stringify([scope, options.preserveOnNavigation ? '' : pathname])} reload={() => window.location.reload()}>
            <Suspense fallback={<div className="lazy-section__loading" role="status" aria-live="polite">
                <Spin size="small" /><Typography.Text>Загружаем раздел «{title}»…</Typography.Text>
            </div>}><Section /></Suspense>
        </LazySectionBoundary>;
    };
    LazySection.displayName = `LazySection(${title})`;
    return LazySection;
}
