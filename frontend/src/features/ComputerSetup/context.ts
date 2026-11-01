import { createContext } from 'react';
import type { IComputerEnvironment } from './context.interfaces';

/** One environment owner is shared by header and setup. */
export const ComputerEnvironmentContext = createContext<IComputerEnvironment | undefined>(undefined);
