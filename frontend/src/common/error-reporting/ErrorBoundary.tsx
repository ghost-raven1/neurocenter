import { Button, Result } from 'antd';
import 'antd/dist/antd.less';
import { Component, ErrorInfo, ReactNode } from 'react';

import { buildClientStackHint } from './clientStackHint';
import { reportClientError } from './reportClientError';

interface IErrorBoundaryProps {
    children: ReactNode;
}

interface IErrorBoundaryState {
    hasError: boolean;
}

/**
 * Имя компонента, где упал render. React 18.3+ отдаёт кадры «at Name (file:line)»,
 * прежние версии — «in Name»: разбираем оба формата, берём первую (внутреннюю) строку.
 */
function extractComponentName(componentStack: string | null | undefined): string | undefined {
    if (!componentStack) {
        return undefined;
    }
    const firstLine = componentStack.split('\n').find((line) => line.trim().length > 0) || '';
    const atMatch = /\bat\s+([A-Za-z_$][\w$]*)\s*\(/.exec(firstLine);
    if (atMatch) {
        return atMatch[1];
    }
    const inMatch = /\bin\s+([A-Za-z_$][\w$]*)/.exec(firstLine);
    return inMatch?.[1];
}

/**
 * AD-O5 (res-obs 6.11): корневая ErrorBoundary SPA.
 *
 * Render-ошибка фиксируется в error-store (safe-поля: фиксированный
 * классификатор, имя компонента, кадры без значений) и заменяется на
 * безопасный fallback — страница не «падает в тишину».
 */
export class ErrorBoundary extends Component<IErrorBoundaryProps, IErrorBoundaryState> {
    public state: IErrorBoundaryState = { hasError: false };

    public static getDerivedStateFromError(): IErrorBoundaryState {
        return { hasError: true };
    }

    public componentDidCatch(error: unknown, info: ErrorInfo): void {
        reportClientError({
            kind: 'render',
            component: extractComponentName(info.componentStack),
            stackHint: buildClientStackHint(error) ?? undefined,
        });
    }

    public render(): ReactNode {
        if (this.state.hasError) {
            return (
                <div className="error-boundary">
                    <Result
                        status="error"
                        title="Что-то пошло не так"
                        subTitle="Ошибка интерфейса зафиксирована. Попробуйте обновить страницу."
                        extra={
                            <Button type="primary" onClick={() => window.location.reload()}>
                                Обновить страницу
                            </Button>
                        }
                    />
                </div>
            );
        }
        return this.props.children;
    }
}

export default ErrorBoundary;
