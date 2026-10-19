import { Button, Result } from 'antd';
import { FC } from 'react';
import { useHistory } from 'react-router-dom';

/**
 * Страница 403: недостаточно прав.
 *
 * @component
 * @returns JSX-элемент с сообщением о запрете доступа
 */
const NotAllowedPage: FC = () => {
    const history = useHistory();

    return (
        <Result
            status="403"
            title="Недостаточно доступа"
            subTitle="Недостаточно прав для просмотра этого раздела."
            extra={<Button type="primary" onClick={() => history.push('/projects')}>К проектам</Button>}
        />
    );
};

export default NotAllowedPage;
