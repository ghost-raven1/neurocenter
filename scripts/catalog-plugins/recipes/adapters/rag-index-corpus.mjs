// Text-only policy for the six raster formats supported by the pinned vision adapter. SVG remains text.
const rasterExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
function isRaster(extension) {
    if (typeof extension !== 'string') return false;
    const normalized = '.' + extension.trim().toLowerCase().replace(/^\./, '');
    // Upstream accepts literal basenames (diagram.png) as well as extension tokens.
    return rasterExtensions.some(suffix => normalized.endsWith(suffix));
}

/**
 * Disabled vision excludes raster from the effective selection, without writing user configuration.
 * An explicit full index consequently prunes old derived raster rows through the normal stale-path cleanup;
 * text stays selected and original files are not changed. Enabled vision keeps the original configuration.
 */
export function indexCorpusConfiguration(config) {
    if (config.imageDescription?.enabled) return config;
    return { ...config,
        indexing: { ...config.indexing, includeExtensions: (config.indexing?.includeExtensions ?? []).filter(extension => !isRaster(extension)) },
        chunking: { ...config.chunking, parsers: Object.fromEntries(Object.entries(config.chunking?.parsers ?? {}).filter(([extension]) => !isRaster(extension))) },
    };
}
