import { useDispatch as useReduxDispatch } from 'react-redux';

import type { TRootDispatch } from '../store';

/**
 * Типизированный useDispatch, принимающий RTK-Thunk'и (тип корня store).
 * В react-redux v9 useDispatch по умолчанию возвращает `Dispatch<UnknownAction>`;
 * здесь переопределяем тип под наш store.
 */
export const useAppDispatch: () => TRootDispatch =
    useReduxDispatch as unknown as () => TRootDispatch;
