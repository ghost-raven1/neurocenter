import { combineReducers, configureStore } from '@reduxjs/toolkit';

import userBlockReducer from './features/UserBlock/redux/reducers';
import operationsReducer from './modules/Operations/redux/reducers';
import accessReducer from './modules/Access/redux/reducers';
import auditReducer from './modules/Audit/redux/reducers';
import maintenanceReducer from './modules/Maintenance/redux/reducers';
import packagesReducer from './modules/Packages/redux/reducers';
import projectsReducer from './modules/Projects/redux/reducers';
import ragReducer from './modules/Rag/redux/reducers';
import skillsReducer from './modules/Skills/redux/reducers';

const rootReducer = combineReducers({
    userBlock: userBlockReducer,
    projects: projectsReducer,
    operations: operationsReducer,
    skills: skillsReducer,
    rag: ragReducer,
    packages: packagesReducer,
    maintenance: maintenanceReducer,
    audit: auditReducer,
    access: accessReducer,
});

/**
 * Создаёт и настраивает корневой store приложения.
 */
export const store = configureStore({
    reducer: rootReducer,
});

/* Типизация корневого state. */
export type RootState = ReturnType<typeof store.getState>;
/* Типизация корневого dispatch. */
export type TRootDispatch = typeof store.dispatch;
