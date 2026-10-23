import './BrandMark.less';

/** The same vector supplies the application mark and browser favicon. */
export function BrandMark({ className = '' }: { className?: string }): JSX.Element {
    return <img className={`brand-mark ${className}`} src="/brand-mark.svg" width={43} height={43} alt="" aria-hidden="true" draggable={false}/>;
}
