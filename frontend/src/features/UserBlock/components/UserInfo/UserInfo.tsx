import { DownOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { Button, Dropdown, message } from 'antd';
import block from 'bem-cn';
import { FC, useCallback } from 'react';
import { useSelector } from 'react-redux';
import { useHistory } from 'react-router-dom';

import { useAppDispatch } from '../../../../core/hooks';
import { RootState } from '../../../../store';
import {authLogout} from '../../redux/actions';

const b = block('user-info');

/**
 * Информация о текущем пользователе + выход в хеддере.
 *
 * @component
 * @returns JSX-элемент блока пользователя
 */
const UserInfo: FC = () => {
    const dispatch = useAppDispatch();
    const { user } = useSelector((state: RootState) => state.userBlock);
    const history = useHistory();

    /**
     * Выход: сначала отзыв серверной сессии, затем экран входа и завершение SSO.
     *
     * @returns void
     */
    const handleLogout = useCallback(async () => {
        try{
            const result=await dispatch(authLogout()).unwrap();
            if(result.redirectUrl){window.location.assign(result.redirectUrl);}else{history.push('/');}
        }catch{message.error('Не удалось завершить сессию. Повторите выход.');}
    }, [ dispatch, history ]);

    if (!user) {
        return null;
    }

    return (
        <Dropdown
            menu={{
                items: [
                    {
                        key: 'logout',
                        icon: <LogoutOutlined />,
                        label: 'Выйти',
                        onClick: () => {
                            void handleLogout();
                        },
                    },
                ],
            }}
            trigger={['click']}
        >
            <Button type="text" className={b().toString()} aria-label="Меню пользователя" icon={<UserOutlined />}>
                <span className="user-info__name">{user.displayName}</span>
                <DownOutlined />
            </Button>
        </Dropdown>
    );
};

export default UserInfo;
