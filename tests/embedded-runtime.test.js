const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const {
    MANIFEST_FILE,
    RuntimeIntegrityError,
    buildRuntimeManifest,
    sanitizeJavaEnvironment,
    serializeManifest,
    sha256File,
    verifyEmbeddedRuntime
} = require('../libs/embedded-runtime');
const {
    RuntimeBuildError,
    jlinkArguments,
    parseChecksumFile,
    validatePin,
    verifyArchive,
    verifySignature
} = require('../libs/java-runtime-build');

const realPin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'java-runtime.json'), 'utf8'));

describe('embedded runtime integrity', () => {
    let dir;
    let expected;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-runtime-'));
        fs.mkdirSync(path.join(dir, 'bin'));
        fs.mkdirSync(path.join(dir, 'lib'));
        fs.writeFileSync(path.join(dir, 'bin', 'javaw.exe'), 'javaw-binary');
        fs.writeFileSync(path.join(dir, 'lib', 'modules'), 'modules-image');
        fs.writeFileSync(path.join(dir, 'release'), 'JAVA_VERSION="17.0.20.1"');
        const manifest = buildRuntimeManifest({
            fs,
            path,
            imageDir: dir,
            description: { javaVersion: '17.0.20.1', fullVersion: '17.0.20.1+1' }
        });
        fs.writeFileSync(path.join(dir, MANIFEST_FILE), serializeManifest(manifest));
        expected = { javaVersion: '17.0.20.1', imageSha256: manifest.imageSha256 };
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const verify = (overrides = {}) =>
        verifyEmbeddedRuntime({ fs, path, runtimeDir: dir, expected: { ...expected, ...overrides } });

    test('accepts the runtime that matches the pin', () => {
        expect(verify()).toMatchObject({ javaVersion: '17.0.20.1', files: 3 });
    });

    test('rejects a modified file (one byte)', () => {
        fs.writeFileSync(path.join(dir, 'lib', 'modules'), 'modules-imagE');
        expect(verify).toThrow(/modified file: lib\/modules/);
    });

    test('rejects a truncated file', () => {
        fs.writeFileSync(path.join(dir, 'bin', 'javaw.exe'), 'javaw');
        expect(verify).toThrow(/modified file: bin\/javaw.exe/);
    });

    test('rejects a missing file', () => {
        fs.rmSync(path.join(dir, 'release'));
        expect(verify).toThrow(/missing a file: release/);
    });

    test('rejects an added file, such as a dropped DLL', () => {
        fs.writeFileSync(path.join(dir, 'bin', 'evil.dll'), 'x');
        expect(verify).toThrow(/unexpected file: bin\/evil.dll/);
    });

    test('rejects a missing runtime directory with a reinstall hint', () => {
        fs.rmSync(dir, { recursive: true, force: true });
        expect(verify).toThrow(/missing from this installation/);
        fs.mkdirSync(dir);
    });

    test('rejects a missing or unreadable manifest', () => {
        fs.rmSync(path.join(dir, MANIFEST_FILE));
        expect(verify).toThrow(/no readable runtime-manifest.json/);
    });

    test('rejects a manifest edited to match a changed file', () => {
        fs.writeFileSync(path.join(dir, 'lib', 'modules'), 'changed');
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
        const entry = manifest.files.find((file) => file.path === 'lib/modules');
        entry.sha256 = sha256File(fs, path.join(dir, 'lib', 'modules'));
        entry.size = 'changed'.length;
        fs.writeFileSync(path.join(dir, MANIFEST_FILE), serializeManifest(manifest));
        expect(verify).toThrow(/manifest is inconsistent/);
    });

    test('rejects a wrong version and a wrong pinned digest', () => {
        expect(() => verify({ javaVersion: '17.0.19' })).toThrow(/expected 17.0.19/);
        expect(() => verify({ imageSha256: 'a'.repeat(64) })).toThrow(
            /does not match the one this launcher was built with/
        );
    });

    test('rejects a build with no valid pin', () => {
        expect(() => verify({ imageSha256: null })).toThrow(/no valid Java runtime pin/);
        expect(() => verify({ javaVersion: '' })).toThrow(RuntimeIntegrityError);
    });

    test('rejects manifest paths that escape the runtime', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
        manifest.files[0].path = '../outside';
        fs.writeFileSync(path.join(dir, MANIFEST_FILE), serializeManifest(manifest));
        expect(verify).toThrow(/lists an invalid file/);
    });
});

describe('Java environment options are removed for the child only', () => {
    test('drops the three variables in any case and reports their names, never values', () => {
        const parent = {
            PATH: 'x',
            JAVA_TOOL_OPTIONS: '-javaagent:evil.jar',
            _JAVA_OPTIONS: '-Xmx1m',
            jdk_java_options: '--add-opens=x',
            KEEP: '1'
        };
        const snapshot = { ...parent };
        const { environment, removed } = sanitizeJavaEnvironment(parent);
        expect(environment).toEqual({ PATH: 'x', KEEP: '1' });
        expect(removed.sort()).toEqual(['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'jdk_java_options'].sort());
        expect(JSON.stringify(removed)).not.toContain('evil');
        expect(parent).toEqual(snapshot);
    });

    test('process.env of the launcher is not touched', () => {
        process.env.JAVA_TOOL_OPTIONS = '-Dtest=1';
        try {
            sanitizeJavaEnvironment(process.env);
            expect(process.env.JAVA_TOOL_OPTIONS).toBe('-Dtest=1');
        } finally {
            delete process.env.JAVA_TOOL_OPTIONS;
        }
    });
});

describe('runtime build verification (B-3.1)', () => {
    test('the committed pin is valid and pins an image digest', () => {
        expect(() => validatePin(realPin)).not.toThrow();
        expect(realPin.image.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(realPin.javaVersion).toBe('17.0.20.1');
        expect(realPin.jlink.modules).toEqual(expect.arrayContaining(['jdk.crypto.mscapi', 'jdk.compiler', 'jdk.attach', 'jdk.jcmd']));
        expect(realPin.jlink.modules).not.toContain('jdk.jshell');
    });

    test.each([
        ['an archive from another host', (p) => { p.archive.url = 'https://example.com/a.zip'; }],
        ['a bad archive digest', (p) => { p.archive.sha256 = 'zz'; }],
        ['a bad fingerprint', (p) => { p.signing.keyFingerprint = 'abc'; }],
        ['a missing commit', (p) => { p.sources.jdk17u = 'abc'; }],
        ['a runtime without the compiler', (p) => { p.jlink.modules = p.jlink.modules.filter((m) => m !== 'jdk.compiler'); }],
        ['a different Java major', (p) => { p.javaVersion = '21.0.1'; }]
    ])('rejects %s', (_label, mutate) => {
        const pin = JSON.parse(JSON.stringify(realPin));
        mutate(pin);
        expect(() => validatePin(pin)).toThrow(RuntimeBuildError);
    });

    test('parses the publisher checksum file and refuses a missing entry', () => {
        const text = `${'a'.repeat(64)}  file.zip\n${'b'.repeat(64)} *other.zip\n`;
        expect(parseChecksumFile(text, 'file.zip')).toBe('a'.repeat(64));
        expect(parseChecksumFile(text, 'other.zip')).toBe('b'.repeat(64));
        expect(() => parseChecksumFile(text, 'absent.zip')).toThrow(/no entry/);
    });

    describe('archive checks', () => {
        let dir;
        let archive;
        let pin;

        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-archive-'));
            archive = path.join(dir, 'a.zip');
            fs.writeFileSync(archive, 'archive-bytes');
            const sha = sha256File(fs, archive);
            pin = { archive: { name: 'a.zip', sha256: sha } };
        });

        afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

        test('accepts a matching archive', () => {
            const sha = pin.archive.sha256;
            expect(verifyArchive({ fs, archivePath: archive, pin, checksumText: `${sha}  a.zip` })).toBe(sha);
        });

        test('a corrupted archive fails', () => {
            const sha = pin.archive.sha256;
            fs.appendFileSync(archive, 'x');
            expect(() => verifyArchive({ fs, archivePath: archive, pin, checksumText: `${sha}  a.zip` })).toThrow(
                /does not match the pinned/
            );
        });

        test('a wrong pin fails', () => {
            const sha = pin.archive.sha256;
            pin.archive.sha256 = 'c'.repeat(64);
            expect(() => verifyArchive({ fs, archivePath: archive, pin, checksumText: `${sha}  a.zip` })).toThrow(
                /does not match the pinned/
            );
        });

        test('a publisher checksum that differs fails even when the pin matches', () => {
            expect(() =>
                verifyArchive({ fs, archivePath: archive, pin, checksumText: `${'d'.repeat(64)}  a.zip` })
            ).toThrow(/publisher's checksum/);
        });
    });

    describe('signature checks (with a stubbed gpg)', () => {
        const fingerprint = realPin.signing.keyFingerprint;
        const keyFile = path.join(__dirname, '..', realPin.signing.publicKeyFile);
        const base = { fs, path, os, archivePath: 'a.zip', signaturePath: 'a.zip.sig', publicKeyPath: keyFile, fingerprint };

        const stub = ({ listing, verify }) => (command, args) => {
            if (command === 'gpg' && args.includes('--show-keys')) return { status: 0, stdout: listing, stderr: '' };
            if (command === 'gpg') return { status: 0, stdout: '', stderr: '' };
            return verify;
        };
        const listingFor = (fpr) => `pub:-:2048:1:AAAA:::\nfpr:::::::::${fpr}:\n`;
        const validSig = (fpr) => ({ status: 0, stdout: `[GNUPG:] VALIDSIG ${fpr} 2026-08-18 1 0 4 0 1 10 00 ${fpr}\n`, stderr: '' });

        test('accepts a valid signature from the pinned key', () => {
            expect(
                verifySignature({ ...base, run: stub({ listing: listingFor(fingerprint), verify: validSig(fingerprint) }) })
            ).toEqual({ signer: fingerprint });
        });

        test('rejects a key file with another fingerprint', () => {
            expect(() =>
                verifySignature({ ...base, run: stub({ listing: listingFor('F'.repeat(40)), verify: validSig(fingerprint) }) })
            ).toThrow(/pinned fingerprint/);
        });

        test('rejects a signature made by another key', () => {
            expect(() =>
                verifySignature({ ...base, run: stub({ listing: listingFor(fingerprint), verify: validSig('E'.repeat(40)) }) })
            ).toThrow(/not by the pinned/);
        });

        test('rejects a bad signature', () => {
            expect(() =>
                verifySignature({ ...base, run: stub({ listing: listingFor(fingerprint), verify: { status: 1, stdout: '[GNUPG:] BADSIG x\n', stderr: '' } }) })
            ).toThrow(/signature of the archive is not valid/);
        });
    });

    test('the jlink command uses the pinned modules and options', () => {
        const args = jlinkArguments({ pin: realPin, jmodsDir: 'J', outputDir: 'O' });
        expect(args.slice(0, 2)).toEqual(['--module-path', 'J']);
        expect(args[args.indexOf('--add-modules') + 1].split(',')).toEqual([...realPin.jlink.modules].sort());
        expect(args).toEqual(expect.arrayContaining(['--strip-debug', '--no-header-files', '--no-man-pages', '--compress=2']));
    });

    const gpgAvailable = childProcess.spawnSync('gpg', ['--version']).status === 0 &&
        childProcess.spawnSync('gpgv', ['--version']).status === 0;
    (gpgAvailable ? test : test.skip)('the committed key file holds the pinned fingerprint (real gpg)', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-gpg-'));
        try {
            const result = childProcess.spawnSync(
                'gpg',
                ['--homedir', home.split(String.fromCharCode(92)).join('/'), '--batch', '--no-tty', '--show-keys', '--with-colons', '--fingerprint',
                    path.join(__dirname, '..', realPin.signing.publicKeyFile).split(String.fromCharCode(92)).join('/')],
                { encoding: 'utf8' }
            );
            expect(result.stdout).toContain(`:${realPin.signing.keyFingerprint}:`);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    const imagePresent = fs.existsSync(path.join(__dirname, '..', '.release-work', 'java-runtime', 'image', MANIFEST_FILE));
    (imagePresent ? test : test.skip)('the built image under .release-work matches the pin', () => {
        const result = verifyEmbeddedRuntime({
            fs,
            path,
            runtimeDir: path.join(__dirname, '..', '.release-work', 'java-runtime', 'image'),
            expected: { javaVersion: realPin.javaVersion, imageSha256: realPin.image.sha256 }
        });
        expect(result.files).toBeGreaterThan(100);
    });
});
