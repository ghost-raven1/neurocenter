import { Tag } from 'antd';
import { FC } from 'react';
import { IStatusTagProps } from './interfaces';
import { T_STATUS_COLOR, T_STATUS_LABEL } from './constants';

/**
 * Цветная метка статуса (единая карта статусов всего приложения).
 *
 * @component
 * @param {string} props.status - код статуса
 * @param {string} [props.label] - подпись
 * @returns JSX-элемент Tag
 */
const StatusTag: FC<IStatusTagProps> = ({ status, label }) => (
    <Tag color={T_STATUS_COLOR[status] ?? 'default'}>{label ?? T_STATUS_LABEL[status] ?? status}</Tag>
);

export default StatusTag;
