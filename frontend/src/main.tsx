import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';

import App from './App';
import { store } from './store';
import { ErrorBoundary, installErrorReporting } from './common/error-reporting';

import './common/styles/app.less';
import ruRU from 'antd/es/locale/ru_RU';
import { ConfigProvider } from 'antd';
import { FeatureAvailabilityProvider } from './features/FeatureFlags/FeatureAvailability';

/**
 * Точка монтирования приложения.
 *
 * @returns void
 */
const main = (): void => {
    const root = document.querySelector('#root');

    if (!root) {
        return;
    }

    // AD-O5 (res-obs 6.11): client-репортинг ошибок (window handlers) + корневая
    // ErrorBoundary — упавший SPA фиксируется в error-store, а не «в тишине».
    installErrorReporting();

    createRoot(root as HTMLElement).render(
        <StrictMode>
            <ConfigProvider locale={ruRU}>
                <Provider store={store}>
                    <BrowserRouter>
                        <FeatureAvailabilityProvider>
                            <ErrorBoundary>
                                <App />
                            </ErrorBoundary>
                        </FeatureAvailabilityProvider>
                    </BrowserRouter>
                </Provider>
            </ConfigProvider>
        </StrictMode>,
    );
};

void main();
