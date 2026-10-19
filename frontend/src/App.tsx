import block from 'bem-cn';
import { FC } from 'react';

import Router from './core/routes';
import 'antd/dist/antd.less';

const b = block('app-root');

/**
 * Корневой компонент приложения.
 *
 * @component
 * @returns JSX-элемент с маршрутизатором
 */
const App: FC = () => (
    <div className={b()}>
        <Router />
    </div>
);

export default App;
