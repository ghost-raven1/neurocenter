import { DownOutlined, ToolOutlined } from '@ant-design/icons';
import type { DetailsHTMLAttributes, ReactNode } from 'react';
import './ChatPresentation.less';

interface IProps extends DetailsHTMLAttributes<HTMLDetailsElement> {
    label: ReactNode;
    icon?: ReactNode;
}

/** Saved activity keeps native keyboard disclosure; its owner decides when to load details. */
export function ChatActivityGroup({
    label,
    icon = <ToolOutlined />,
    children,
    className = '',
    ...props
}: IProps): JSX.Element {
    return (
        <details {...props} className={`chat-activity ${className}`}>
            <summary>
                <span className="chat-activity__icon" aria-hidden="true">
                    {icon}
                </span>
                <span className="chat-activity__label">{label}</span>
                <DownOutlined className="chat-activity__chevron" aria-hidden="true" />
            </summary>
            <div className="chat-activity__body">{children}</div>
        </details>
    );
}
