import type { FC } from 'react';
import Markdown from 'react-markdown';
import { instructionUrl } from './storeDetails';

/** Читает Markdown без HTML и без неподтверждённых запросов к ресурсам скилла. */
const StoreInstruction: FC<{ body: string }> = ({ body }) => (
    <article className="store-details__markdown" aria-label="Текст инструкции">
        <Markdown
            skipHtml
            urlTransform={url => instructionUrl(url) ?? ''}
            components={{
                a: ({ href, children }) => href
                    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                    : <span className="store-details__resource" title="Ресурс не опубликован отдельным файлом. Адрес указан в исходнике инструкции.">{children} <small>(см. исходник)</small></span>,
                img: ({ alt }) => <span className="store-details__resource">Изображение: {alt || 'без подписи'} <small>(ресурс указан в исходнике)</small></span>,
            }}
        >{body}</Markdown>
    </article>
);

export default StoreInstruction;
