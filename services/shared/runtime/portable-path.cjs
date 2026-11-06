'use strict';
function portablePath(value) {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        Buffer.byteLength(value) <= 240 &&
        !value.includes('\\') &&
        !value.startsWith('/') &&
        value
            .split('/')
            .every(
                (part) =>
                    part &&
                    part !== '.' &&
                    part !== '..' &&
                    !/[<>:"|?*\x00-\x1f\x7f]/.test(part) &&
                    !/[. ]$/.test(part) &&
                    !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part),
            )
    );
}
module.exports = { portablePath };
