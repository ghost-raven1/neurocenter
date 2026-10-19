import type { FC } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Показывает локальную справку без HTML и автоматической загрузки внешних изображений. */
const ExtensionInstruction: FC<{ content: string }> = ({ content }) => (
    <article className="extension-instruction__text" aria-label="Инструкция подключения расширения">
        <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
            img: ({ alt }) => <span>{alt || 'Изображение из инструкции'}</span>,
            a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
        }}>{content}</Markdown>
    </article>
);

export default ExtensionInstruction;
