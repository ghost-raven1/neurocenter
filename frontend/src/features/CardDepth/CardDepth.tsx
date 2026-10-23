import { useEffect } from 'react';
import './CardDepth.less';

/** Hover emphasis changes only the shadow; page cards never rotate or move. */
export function CardDepth({ enabled }: { enabled: boolean }): null {
    useEffect(() => {
        document.documentElement.classList.toggle('card-depth-enabled', enabled);
        return () => document.documentElement.classList.remove('card-depth-enabled');
    }, [enabled]);
    return null;
}
