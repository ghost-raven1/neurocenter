'use strict';

const SOURCE_EXTENSIONS = Object.freeze(['ts', 'mts', 'cts', 'mjs', 'js', 'cjs', 'tsx']);

/** Декларации типов не исполняются; исходники JS/TS проходят общий компилятор. */
function isSourceEntrypoint(value) {
 return typeof value === 'string' && /\.(?:[cm]?[jt]s|tsx)$/.test(value) && !/\.d\.[cm]?ts$/.test(value);
}

function isTypeScriptEntrypoint(value) {
 return isSourceEntrypoint(value) && /\.(?:[cm]?ts|tsx)$/.test(value);
}

module.exports = {SOURCE_EXTENSIONS, isSourceEntrypoint, isTypeScriptEntrypoint};
