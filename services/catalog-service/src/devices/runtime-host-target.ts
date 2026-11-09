import { getHostTarget } from '../../../shared/runtime/host-target.cjs';

/** Платформа, на которой площадка исполняет комплекты (контейнер сервиса = платформа хоста). */
export function runtimeArtifactTarget(): string {
    return getHostTarget({ mode: 'unknown' });
}
