import { Redirect, useLocation } from 'react-router-dom';

import { baseRoutes } from '../../core/baseRoutes';

/** Старые закладки открывают ту же очередь в шапке, сохраняя параметры и историю браузера. */
const LegacyOperationsRedirect = (): JSX.Element => {
    const location = useLocation();
    const search = new URLSearchParams(location.search);
    search.set('operations', 'open');
    return <Redirect to={`${baseRoutes.projects}?${search}${location.hash}`} />;
};

export default LegacyOperationsRedirect;
