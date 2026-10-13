const path = require('path');

const PATH_ARGS = {
    writeFileSync: [0],
    appendFileSync: [0],
    mkdirSync: [0],
    unlinkSync: [0],
    rmSync: [0],
    rmdirSync: [0],
    truncateSync: [0],
    utimesSync: [0],
    chmodSync: [0],
    renameSync: [0, 1],
    copyFileSync: [1],
    symlinkSync: [1],
    linkSync: [1]
};
const WRITE_FLAGS = /[wa+]/;

function isUnder(candidate, directory) {
    if (typeof candidate !== 'string') return false;
    const relative = path.relative(path.resolve(directory), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Wraps `fs` so that any mutating call that touches a path under `guardedDirectory` throws and
 * is recorded. `renameSync` is checked on both ends (a rename removes the source). Reads pass.
 */
function guardDirectory(realFs, guardedDirectory) {
    const violations = [];
    const wrapped = new Proxy(realFs, {
        get(target, property) {
            const value = target[property];
            if (typeof value !== 'function') return value;
            return (...args) => {
                let touches = (PATH_ARGS[property] || []).some((index) =>
                    isUnder(args[index], guardedDirectory)
                );
                if (
                    property === 'openSync' &&
                    typeof args[1] === 'string' &&
                    WRITE_FLAGS.test(args[1]) &&
                    isUnder(args[0], guardedDirectory)
                ) {
                    touches = true;
                }
                if (touches) {
                    const message = `write to guarded directory: ${String(property)}(${String(args[0])})`;
                    violations.push(message);
                    throw new Error(message);
                }
                return value.apply(target, args);
            };
        }
    });
    return { fs: wrapped, violations };
}

module.exports = { guardDirectory, isUnder };
