import { useEffect } from 'react';
import { installCardDepth } from './motion';
import './CardDepth.less';

/** The global appearance owner controls listener lifetime and feature availability. */
export function CardDepth({ enabled }: { enabled: boolean }): null {
    useEffect(() => enabled ? installCardDepth(document) : undefined, [enabled]);
    return null;
}
