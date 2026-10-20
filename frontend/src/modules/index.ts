import type { IModule } from '../core/interfaces';

import Access from './Access';
import Assets from './Assets';
import Audit from './Audit';
import Maintenance from './Maintenance';
import Projects from './Projects';
import Rag from './Rag';
import Start from './Start';
import Store from './Store';

/**
 * Реестр функциональных модулей приложения (без оболочки Core).
 * Единая витрина приложений — «Магазин» (/store); «Передачи и проверки» —
 * в шапке (Drawer, realtime); прежние отдельные экраны вынесены в витрину.
 */
export const contentModules: IModule[] = [
    Start,
    Store,
    Assets,
    Projects,
    Rag,
    Maintenance,
    Audit,
    Access,
];

export default contentModules;
