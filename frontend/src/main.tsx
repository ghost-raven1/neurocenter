import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';

import App from './App';
import { store } from './store';

import './common/styles/app.less';
import ruRU from 'antd/es/locale/ru_RU';
import { ConfigProvider } from 'antd';

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

    createRoot(root as HTMLElement).render(
        <StrictMode>
          <ConfigProvider locale={ruRU}>
            <Provider store={store}>
                <BrowserRouter>
                    <App />
                </BrowserRouter>
            </Provider>
          </ConfigProvider>
        </StrictMode>,
    );
};

void main();
