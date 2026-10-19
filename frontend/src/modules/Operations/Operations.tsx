import { Card, Typography } from 'antd';
import { FC } from 'react';

import OperationsQueue from './OperationsQueue';

const { Title } = Typography;

/**
 * Экран «Передачи и проверки»: общая очередь операций по всем проектам
 * (в карточке проекта — та же очередь, отфильтрованная по projectId).
 *
 * @component
 * @returns JSX-элемент глобального списка операций
 */
const Operations: FC = () => (
    <Card title={<Title level={4} style={{ margin: 0 }}>Передачи и проверки</Title>}>
        <OperationsQueue />
    </Card>
);

export default Operations;
