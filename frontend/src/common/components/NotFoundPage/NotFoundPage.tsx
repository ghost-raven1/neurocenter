import { Button, Result } from 'antd';
import { FC } from 'react';
import { useHistory } from 'react-router-dom';

import { baseRoutes } from '../../../core/baseRoutes';

/**
 * Страница 404: маршрут не найден.
 *
 * @component
 * @returns JSX-элемент с сообщением «не найдено»
 */
const NotFoundPage: FC = () => {
    const history = useHistory();

    return (
        <Result
            status="404"
            title="Страница не найдена"
            subTitle="Страница не найдена."
            extra={<Button type="primary" onClick={() => history.push(baseRoutes.projects)}>К проектам</Button>}
        />
    );
};

export default NotFoundPage;
