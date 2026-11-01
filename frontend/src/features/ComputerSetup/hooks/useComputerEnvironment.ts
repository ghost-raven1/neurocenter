import { useContext } from 'react';
import { ComputerEnvironmentContext } from '../context';
import type { IComputerEnvironment } from '../context.interfaces';

export function useComputerEnvironment(): IComputerEnvironment {
    const value = useContext(ComputerEnvironmentContext);
    if (!value) throw new Error('Computer environment requires its authenticated shell owner.');
    return value;
}
