import {FileTextOutlined} from '@ant-design/icons';
import './ChatPresentation.less';

/** A document miniature represents the existing text preview without fetching an original file. */
export function ChatDocumentIcon({name}: {name: string}): JSX.Element {
    const suffix = name.includes('.') ? name.split('.').pop()?.slice(0, 5).toLocaleUpperCase() : undefined;
    return <span className="chat-document-icon" aria-hidden="true"><FileTextOutlined/><span>{suffix || 'ТЕКСТ'}</span></span>;
}
