import { Button, Collapse, Typography } from 'antd';
import { Children, isValidElement, useEffect, useId, useRef, useState, type FC, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ISkillResource } from '../../core/api/interfaces';
import { instructionResourceLink, instructionResourceText, safeInstructionResourcePath, type IInstructionResourceLink } from './instructionResources';
import { instructionUrl } from './storeDetails';
import './StoreInstruction.less';

interface IProps { body: string; resources?: ISkillResource[]; skillKey?: string; }
interface INavigation { key: string; history: string[]; fragment: string; }
const headingText = (children: ReactNode): string => Children.toArray(children).map(child => isValidElement<{ children?: ReactNode }>(child) ? headingText(child.props.children) : String(child)).join('');

/** Читает только ресурсы уже полученной версии, без новых запросов и выполнения их содержимого. */
const StoreInstruction: FC<IProps> = ({ body, resources = [], skillKey = body }) => {
    const [navigation, setNavigation] = useState<INavigation | null>(null);
    const root = useRef<HTMLElement>(null);
    const prefix = useId().replace(/:/g, '');
    const page = navigation?.key === skillKey ? navigation : null;
    const history = page?.history ?? [];
    const path = history[history.length - 1] ?? 'SKILL.md';
    const resource = resources.find(item => item.path === path && safeInstructionResourcePath(item.path));
    const content = path === 'SKILL.md' ? body : resource ? instructionResourceText(resource) : undefined;
    const markdown = path === 'SKILL.md' || /\.(md|markdown)$/i.test(path);
    const files = resources.filter(item => safeInstructionResourcePath(item.path));
    const open = (link: IInstructionResourceLink): void => {
        setNavigation({ key: skillKey, history: link.path === 'SKILL.md' ? [] : link.path === path ? history : [...history, link.path], fragment: link.fragment });
    };
    useEffect(() => {
        if (!page) { return; }
        const heading = page.fragment ? Array.from(root.current?.querySelectorAll<HTMLElement>('[data-instruction-heading]') ?? [])
            .find(item => item.dataset.instructionHeading === page.fragment) : undefined;
        (heading ?? root.current)?.scrollIntoView({ block: 'start' });
    }, [navigation, skillKey]);
    const slugs = new Map<string, number>();
    const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => ({ children }: { children?: ReactNode }) => {
        const slug = headingText(children).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
        const count = slugs.get(slug) ?? 0;
        slugs.set(slug, count + 1);
        const anchor = slug + (count ? `-${count}` : '');
        return <Tag id={`${prefix}-${anchor}`} data-instruction-heading={anchor}>{children}</Tag>;
    };
    return <>
        {history.length > 0 && <div className="store-instruction__navigation">
            <Button size="small" aria-label="Назад к предыдущему файлу" onClick={() => setNavigation({ key: skillKey, history: history.slice(0, -1), fragment: '' })}>Назад</Button>
            <Button size="small" aria-label="К инструкции" onClick={() => open({ path: 'SKILL.md', fragment: '' })}>К инструкции</Button>
            <Typography.Text code title={path}>{path}</Typography.Text>
        </div>}
        <article ref={root} className="store-details__markdown" aria-label={path === 'SKILL.md' ? 'Текст инструкции' : `Ресурс ${path}`}>
            {content === undefined ? <p>Этот ресурс не удалось показать как текст. Вернитесь к инструкции или выберите другой файл.</p>
                : !markdown ? <pre className="store-details__source" tabIndex={0}>{content}</pre>
                    : <Markdown remarkPlugins={[remarkGfm]} skipHtml
                        urlTransform={url => instructionUrl(url) ?? (instructionResourceLink(url, files, path) ? url : '')}
                        components={{
                            a: ({ href, children }) => {
                                const external = href && instructionUrl(href);
                                const local = href && instructionResourceLink(href, files, path);
                                return external ? <a href={external} target="_blank" rel="noopener noreferrer">{children}</a>
                                    : local ? <Button type="link" size="small" className="store-instruction__link" aria-label={`Открыть ${local.path}${local.fragment ? '#' + local.fragment : ''}`} onClick={() => open(local)}>{children}</Button>
                                        : <span className="store-details__resource" title="Ссылка недоступна в опубликованной версии скилла.">{children} <small>(см. исходник)</small></span>;
                            },
                            img: ({ alt }) => <span className="store-details__resource">Изображение: {alt || 'без подписи'} <small>(ресурс указан в исходнике)</small></span>,
                            h1: heading('h1'), h2: heading('h2'), h3: heading('h3'), h4: heading('h4'), h5: heading('h5'), h6: heading('h6'),
                            table: ({ children }) => <div className="store-instruction__table" tabIndex={0}><table>{children}</table></div>,
                        }}>{content}</Markdown>}
        </article>
        {files.length > 0 && <Collapse className="store-instruction__files">
            <Collapse.Panel key="files" header={`Файлы скилла · ${files.length}`}>
                <div className="store-instruction__file-list">{files.map(file => <Button key={file.path} type="link" aria-label={`Просмотреть файл ${file.path}`} onClick={() => open({ path: file.path, fragment: '' })}>{file.path}</Button>)}</div>
            </Collapse.Panel>
        </Collapse>}
    </>;
};

export default StoreInstruction;
