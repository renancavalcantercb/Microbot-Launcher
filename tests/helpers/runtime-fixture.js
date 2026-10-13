const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    MANIFEST_FILE,
    buildRuntimeManifest,
    serializeManifest
} = require('../../libs/embedded-runtime');

/**
 * A tiny stand-in for the embedded Java runtime: a few files plus a real runtime-manifest.json,
 * so the production verification code runs against it. `pin` is what a distribution profile holds.
 */
function createRuntimeFixture({ javaVersion = '17.0.20.1' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-fixture-'));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'bin', 'java.exe'), 'java-binary');
    fs.writeFileSync(path.join(dir, 'bin', 'javaw.exe'), 'javaw-binary');
    fs.writeFileSync(path.join(dir, 'lib', 'modules'), 'modules-image');
    fs.writeFileSync(path.join(dir, 'release'), `JAVA_VERSION="${javaVersion}"`);
    const manifest = buildRuntimeManifest({
        fs,
        path,
        imageDir: dir,
        description: { javaVersion, fullVersion: `${javaVersion}+1` }
    });
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), serializeManifest(manifest));
    return {
        dir,
        pin: { directory: 'java-runtime', javaVersion, imageSha256: manifest.imageSha256 },
        probeOutput: [
            `    java.home = ${dir}`,
            `    java.version = ${javaVersion}`,
            '    sun.arch.data.model = 64',
            `openjdk version "${javaVersion}"`
        ].join('\n'),
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
    };
}

module.exports = { createRuntimeFixture };
