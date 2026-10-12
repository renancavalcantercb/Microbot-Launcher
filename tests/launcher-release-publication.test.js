const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    buildUpdaterMetadata,
    installerFileName,
    launcherBundleDirectory,
    launcherObjectKeys,
    parseUpdaterMetadata,
    prepareLauncherRelease,
    readAndVerifyLauncherBundle,
    requireClientReleaseKeepsLauncher,
    requireLauncherReleaseKeepsClient,
    requireSameSourceCandidates,
    verifyLauncherCandidate,
    verifyUpdaterMetadata
} = require('../libs/launcher-release-publication');
const {
    bundleDirectory,
    prepareClientRelease,
    prepareClientRollback,
    requireNewerSequence
} = require('../libs/client-release-publication');
const { verifyReleaseManifest } = require('../libs/release-manifest');

const VERSION = '3.2.11';
const FILE_NAME = `Microbot-Cut-Launcher-Setup-${VERSION}.exe`;
const CLIENT = Object.freeze({
    version: 'cut-2.6.31-p13',
    minimumLauncherVersion: '3.2.10',
    artifactPath: 'releases/artifacts/client/cut-2.6.31-p13/microbot-cut-2.6.31-p13.jar',
    size: 1234,
    sha256: 'b'.repeat(64)
});

function sha512Base64(bytes) {
    return crypto.createHash('sha512').update(bytes).digest('base64');
}

const COMMIT = 'a'.repeat(40);

// What scripts/build-distribution.js records next to an installer.
function candidateFor(profile, bytes, overrides = {}) {
    return {
        kind: 'launcher-candidate',
        unsigned: true,
        profile,
        version: VERSION,
        file: FILE_NAME,
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        sha512Base64: sha512Base64(bytes),
        sourceCommit: COMMIT,
        sourceDirty: false,
        effectiveConfiguration: {
            environment: profile,
            releaseChannel: profile,
            environmentVariableOverrides: false,
            launcherUpdateFeed: null
        },
        embeddedProfileSha256: crypto.createHash('sha256').update('profile-' + profile).digest('hex'),
        appAsarSha256: crypto.createHash('sha256').update('asar-' + profile).digest('hex'),
        ...overrides
    };
}

describe('launcher release publication', () => {
    let directory;
    let installerPath;
    let installerBytes;
    let privateKeyPem;
    let publicKey;

    const prepare = (overrides = {}) => prepareLauncherRelease({
        installerPath,
        outputDirectory: launcherBundleDirectory(directory, 'staging', VERSION, 20),
        channel: 'staging',
        version: VERSION,
        minimumSupportedVersion: '3.2.10',
        sequence: 20,
        currentClient: CLIENT,
        keyId: 'release-staging-test',
        privateKeyPem,
        publicKey,
        publishedAt: '2026-10-12T12:00:00.000Z',
        candidate: candidateFor('staging', installerBytes),
        ...overrides
    });

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-launcher-release-test-'));
        fs.mkdirSync(path.join(directory, 'input'));
        installerPath = path.join(directory, 'input', FILE_NAME);
        installerBytes = crypto.randomBytes(4096);
        fs.writeFileSync(installerPath, installerBytes);
        const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
        publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    });

    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    describe('updater metadata', () => {
        const metadata = (overrides = {}) => buildUpdaterMetadata({
            version: VERSION,
            fileName: FILE_NAME,
            size: 4096,
            sha512Base64: sha512Base64('x'),
            releaseDate: '2026-10-12T12:00:00Z',
            ...overrides
        });

        test('writes the generic-provider format electron-updater reads', () => {
            const text = metadata();
            expect(text).toBe([
                `version: ${VERSION}`,
                'files:',
                `  - url: ${FILE_NAME}`,
                `    sha512: ${sha512Base64('x')}`,
                '    size: 4096',
                `path: ${FILE_NAME}`,
                `sha512: ${sha512Base64('x')}`,
                "releaseDate: '2026-10-12T12:00:00.000Z'",
                ''
            ].join('\n'));
            expect(parseUpdaterMetadata(text)).toMatchObject({ version: VERSION, path: FILE_NAME, fileSize: 4096 });
        });

        test('refuses a file name, version, size or digest that breaks the contract', () => {
            expect(() => metadata({ fileName: 'Microbot Cut Launcher Setup 3.2.11.exe' })).toThrow(/file name/);
            expect(() => metadata({ version: '3.2' })).toThrow(/version/);
            expect(() => metadata({ size: 0 })).toThrow(/size/);
            expect(() => metadata({ sha512Base64: 'short' })).toThrow(/sha512/);
            expect(() => metadata({ releaseDate: 'not a date' })).toThrow(/release date/);
        });

        test('rejects a file that is not exactly the generated shape', () => {
            const text = metadata();
            expect(() => parseUpdaterMetadata(`${text}extra: 1\n`)).toThrow(/shape/);
            expect(() => parseUpdaterMetadata(text.replace('files:', 'files: []'))).toThrow(/shape/);
            expect(() => parseUpdaterMetadata(text.replace(`path: ${FILE_NAME}`, 'path: other.exe\npath: x')))
                .toThrow(/shape/);
        });

        test('detects every way latest.yml can disagree with the installer', () => {
            const good = buildUpdaterMetadata({
                version: VERSION,
                fileName: FILE_NAME,
                size: installerBytes.length,
                sha512Base64: sha512Base64(installerBytes),
                releaseDate: '2026-10-12T12:00:00Z'
            });
            expect(verifyUpdaterMetadata({ metadataText: good, installerPath, version: VERSION }))
                .toMatchObject({ size: installerBytes.length, sha512Base64: sha512Base64(installerBytes) });

            const wrongDigest = good.split(sha512Base64(installerBytes)).join(sha512Base64('other'));
            expect(() => verifyUpdaterMetadata({ metadataText: wrongDigest, installerPath, version: VERSION }))
                .toThrow(/sha512 does not match/);
            const wrongSize = good.replace(`size: ${installerBytes.length}`, `size: ${installerBytes.length + 1}`);
            expect(() => verifyUpdaterMetadata({ metadataText: wrongSize, installerPath, version: VERSION }))
                .toThrow(/size does not match/);
            const wrongName = good.split(FILE_NAME).join('Microbot-Cut-Launcher-Setup-9.9.9.exe');
            expect(() => verifyUpdaterMetadata({ metadataText: wrongName, installerPath, version: VERSION }))
                .toThrow(/file name does not match/);
            const wrongVersion = good.replace(`version: ${VERSION}`, 'version: 3.2.12');
            expect(() => verifyUpdaterMetadata({ metadataText: wrongVersion, installerPath, version: VERSION }))
                .toThrow(/version does not match/);

            fs.writeFileSync(installerPath, Buffer.concat([installerBytes, Buffer.from('tampered')]));
            expect(() => verifyUpdaterMetadata({ metadataText: good, installerPath, version: VERSION }))
                .toThrow(/size does not match/);
        });
    });

    describe('prepareLauncherRelease', () => {
        test('writes a signed bundle whose paths follow the site contract exactly', () => {
            const outputDirectory = launcherBundleDirectory(directory, 'staging', VERSION, 20);
            const result = prepare();
            const keys = launcherObjectKeys(VERSION);

            expect(keys.installer).toBe(`releases/artifacts/launcher/${VERSION}/windows/${FILE_NAME}`);
            expect(keys.updater).toBe(`releases/artifacts/launcher/${VERSION}/windows/latest.yml`);
            expect(result.payload.launcher).toEqual({
                version: VERSION,
                minimumSupportedVersion: '3.2.10',
                platforms: {
                    'windows-x64': {
                        artifactPath: keys.installer,
                        updaterMetadataPath: keys.updater,
                        size: installerBytes.length,
                        sha256: crypto.createHash('sha256').update(installerBytes).digest('hex')
                    }
                }
            });
            expect(fs.readFileSync(path.join(outputDirectory, FILE_NAME)).equals(installerBytes)).toBe(true);

            const verified = verifyReleaseManifest(result.envelope, {
                expectedChannel: 'staging',
                trustedKeys: { 'release-staging-test': publicKey }
            });
            expect(verified.sequence).toBe(20);
            const release = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'release.json'), 'utf8'));
            expect(release).toMatchObject({
                kind: 'launcher',
                artifactObjectKey: keys.installer,
                updaterObjectKey: keys.updater,
                manifestObjectKey: 'releases/staging/manifest.json'
            });
        });

        test('carries the current client entry over unchanged', () => {
            const { payload } = prepare();
            expect(payload.client).toEqual(CLIENT);
            expect(() => prepare({ outputDirectory: path.join(directory, 'other'), currentClient: null }))
                .toThrow(/carry over the current client/);
        });

        test('refuses an installer whose file name is not the release name', () => {
            const renamed = path.join(directory, 'input', 'Microbot Cut Launcher Setup 3.2.11.exe');
            fs.renameSync(installerPath, renamed);
            expect(() => prepare({ installerPath: renamed })).toThrow(/file name must be/);
            expect(fs.existsSync(launcherBundleDirectory(directory, 'staging', VERSION, 20))).toBe(false);
        });

        test('never overwrites an existing bundle and cleans up after a failure', () => {
            const outputDirectory = launcherBundleDirectory(directory, 'staging', VERSION, 20);
            prepare();
            expect(() => prepare()).toThrow(/already exists/);
            expect(fs.existsSync(path.join(outputDirectory, 'manifest.json'))).toBe(true);

            const failing = launcherBundleDirectory(directory, 'staging', VERSION, 21);
            expect(() => prepare({ outputDirectory: failing, sequence: 21, keyId: 'bad key id' })).toThrow();
            expect(fs.existsSync(failing)).toBe(false);
        });

        test('validates the release identity', () => {
            expect(() => prepare({ version: '3.2' })).toThrow(/version is invalid/);
            expect(() => prepare({ minimumSupportedVersion: 'latest' })).toThrow(/minimum supported/);
            expect(() => prepare({ channel: 'internal' })).toThrow(/channel is invalid/);
            expect(() => prepare({ sequence: 0 })).toThrow(/sequence/);
            expect(() => launcherBundleDirectory(directory, 'staging', '../3.2.11', 1)).toThrow(/version is invalid/);
        });

        test('the new sequence must be strictly higher than the live one', () => {
            const { payload } = prepare();
            expect(() => requireNewerSequence(payload, { sequence: 20 })).toThrow(/must be greater/);
            expect(() => requireNewerSequence(payload, { sequence: 19 })).not.toThrow();
        });
    });

    describe('readAndVerifyLauncherBundle', () => {
        const read = () => readAndVerifyLauncherBundle({
            outputDirectory: launcherBundleDirectory(directory, 'staging', VERSION, 20),
            channel: 'staging',
            keyId: 'release-staging-test',
            publicKey
        });

        test('accepts an untouched bundle', () => {
            prepare();
            expect(read().payload.launcher.version).toBe(VERSION);
        });

        test('detects a tampered installer or latest.yml', () => {
            prepare();
            const outputDirectory = launcherBundleDirectory(directory, 'staging', VERSION, 20);
            const installer = path.join(outputDirectory, FILE_NAME);
            const original = fs.readFileSync(installer);

            const flipped = Buffer.from(original);
            flipped[0] ^= 0xff;
            fs.writeFileSync(installer, flipped);
            expect(read).toThrow(/SHA-256 does not match/);
            fs.writeFileSync(installer, original);
            expect(read).not.toThrow();

            const yml = path.join(outputDirectory, 'latest.yml');
            const text = fs.readFileSync(yml, 'utf8');
            fs.writeFileSync(yml, text.replace(/size: \d+/, 'size: 1'));
            expect(read).toThrow(/size does not match/);
        });

        test('rejects a manifest signed by an untrusted key', () => {
            prepare();
            const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
            expect(() => readAndVerifyLauncherBundle({
                outputDirectory: launcherBundleDirectory(directory, 'staging', VERSION, 20),
                channel: 'staging',
                keyId: 'release-staging-test',
                publicKey: other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
            })).toThrow();
        });
    });

    describe('keeping the live manifest consistent', () => {
        const liveWithLauncher = () => prepare().payload;

        test('a client release prepared without the launcher is refused when one is live', () => {
            const live = liveWithLauncher();
            const clientOnly = { ...live, sequence: 21, launcher: null };
            expect(() => requireClientReleaseKeepsLauncher(clientOnly, live)).toThrow(/remove or change the live launcher/);
            expect(() => requireClientReleaseKeepsLauncher({ ...live, sequence: 21 }, live)).not.toThrow();
            expect(() => requireClientReleaseKeepsLauncher(clientOnly, null)).not.toThrow();
            expect(() => requireClientReleaseKeepsLauncher(clientOnly, { ...live, launcher: null })).not.toThrow();
        });

        test('a launcher release is refused when the live client entry changed since it was prepared', () => {
            const live = liveWithLauncher();
            expect(() => requireLauncherReleaseKeepsClient(live, { ...live, client: { ...CLIENT, version: 'newer' } }))
                .toThrow(/change the live client/);
            expect(() => requireLauncherReleaseKeepsClient(live, live)).not.toThrow();
        });

        test('client releases and rollbacks carry the live launcher entry over', () => {
            const live = liveWithLauncher();
            const sourceJar = path.join(directory, 'input', 'source.jar');
            fs.writeFileSync(sourceJar, 'client bytes');
            const common = {
                channel: 'staging',
                keyId: 'release-staging-test',
                privateKeyPem,
                publicKey,
                launcher: live.launcher
            };
            const prepared = prepareClientRelease({
                ...common,
                sourceJar,
                outputDirectory: bundleDirectory(directory, 'staging', 'cut-2.6.31-p14', 21),
                version: 'cut-2.6.31-p14',
                sequence: 21,
                minimumLauncherVersion: '3.2.10'
            });
            expect(prepared.payload.launcher).toEqual(live.launcher);
            expect(() => requireClientReleaseKeepsLauncher(prepared.payload, live)).not.toThrow();

            const rollback = prepareClientRollback({
                ...common,
                sourceDirectory: bundleDirectory(directory, 'staging', 'cut-2.6.31-p14', 21),
                outputDirectory: bundleDirectory(directory, 'staging', 'cut-2.6.31-p14', 22),
                sequence: 22
            });
            expect(rollback.payload.launcher).toEqual(live.launcher);
        });

        test('a client release still defaults to no launcher when none is live', () => {
            const sourceJar = path.join(directory, 'input', 'source.jar');
            fs.writeFileSync(sourceJar, 'client bytes');
            const prepared = prepareClientRelease({
                sourceJar,
                outputDirectory: bundleDirectory(directory, 'staging', 'cut-2.6.31-p14', 3),
                channel: 'staging',
                version: 'cut-2.6.31-p14',
                sequence: 3,
                minimumLauncherVersion: '3.2.10',
                keyId: 'release-staging-test',
                privateKeyPem,
                publicKey
            });
            expect(prepared.payload.launcher).toBeNull();
        });
    });

    describe('per-environment candidates', () => {
        const stagingBytes = () => installerBytes;

        test('records the profile and source in the bundle', () => {
            prepare();
            const release = JSON.parse(fs.readFileSync(
                path.join(launcherBundleDirectory(directory, 'staging', VERSION, 20), 'release.json'), 'utf8'));
            expect(release).toMatchObject({ profile: 'staging', sourceCommit: COMMIT, sourceDirty: false });
            expect(release.embeddedProfileSha256).toMatch(/^[0-9a-f]{64}$/);
        });

        const effective = (overrides) => ({
            environment: 'staging',
            releaseChannel: 'staging',
            environmentVariableOverrides: false,
            launcherUpdateFeed: null,
            ...overrides
        });

        test.each([
            ['a candidate for the other environment', { profile: 'production' }, /built for production/],
            ['a mismatched effective configuration', { effectiveConfiguration: effective({ environment: 'production' }) }, /effective configuration/],
            ['environment variable overrides', { effectiveConfiguration: effective({ environmentVariableOverrides: true }) }, /overrides/],
            ['a launcher update feed', { effectiveConfiguration: effective({ launcherUpdateFeed: 'https://x' }) }, /update feed/],
            ['another version', { version: '3.2.12' }, /version/],
            ['a dirty working tree', { sourceDirty: true }, /uncommitted/],
            ['a missing or short commit', { sourceCommit: 'abc' }, /source commit/],
            ['a corrupt profile hash', { embeddedProfileSha256: 'zz' }, /embeddedProfileSha256/],
            ['bytes that do not match the record', { sha256: 'f'.repeat(64) }, /do not match/],
            ['a wrong kind', { kind: 'launcher-l2-candidate' }, /wrong kind/]
        ])('refuses %s', (_label, overrides, pattern) => {
            expect(() => prepare({ candidate: candidateFor('staging', stagingBytes(), overrides) })).toThrow(pattern);
            expect(fs.existsSync(launcherBundleDirectory(directory, 'staging', VERSION, 20))).toBe(false);
        });

        test('refuses a release without a candidate', () => {
            expect(() => prepare({ candidate: undefined })).toThrow(/candidate/);
        });

        test('a production bundle needs the staging candidate of the same source', () => {
            const productionBytes = crypto.randomBytes(4096);
            const stagingCandidate = candidateFor('staging', stagingBytes());
            fs.writeFileSync(installerPath, productionBytes);
            const candidate = candidateFor('production', productionBytes);
            const production = (overrides = {}) => prepare({
                outputDirectory: launcherBundleDirectory(directory, 'production', VERSION, 21),
                channel: 'production',
                sequence: 21,
                candidate,
                stagingCandidate,
                ...overrides
            });
            expect(() => production({ stagingCandidate: null })).toThrow(/staging candidate/);
            expect(() => production({ stagingCandidate: { ...stagingCandidate, sourceCommit: 'b'.repeat(40) } }))
                .toThrow(/different commits/);
            expect(() => production({ stagingCandidate: { ...stagingCandidate, version: '3.2.12' } }))
                .toThrow(/different versions/);
            expect(() => production({ stagingCandidate: { ...stagingCandidate, sha256: candidate.sha256 } }))
                .toThrow(/not environment-specific/);
            expect(() => production({
                stagingCandidate: { ...stagingCandidate, embeddedProfileSha256: candidate.embeddedProfileSha256 }
            })).toThrow(/not environment-specific/);
            expect(production().payload.channel).toBe('production');
        });

        test('requireSameSourceCandidates demands one staging and one production candidate', () => {
            const a = candidateFor('staging', Buffer.from('a'));
            const b = candidateFor('production', Buffer.from('b'));
            expect(() => requireSameSourceCandidates(a, b)).not.toThrow();
            expect(() => requireSameSourceCandidates(b, a)).toThrow(/one staging and one production/);
            expect(() => requireSameSourceCandidates(a, a)).toThrow(/one staging and one production/);
        });

        test('a read-back bundle whose profile is not its channel is refused', () => {
            prepare();
            const outputDirectory = launcherBundleDirectory(directory, 'staging', VERSION, 20);
            const file = path.join(outputDirectory, 'release.json');
            const release = JSON.parse(fs.readFileSync(file, 'utf8'));
            fs.writeFileSync(file, JSON.stringify({ ...release, profile: 'production' }));
            expect(() => readAndVerifyLauncherBundle({
                outputDirectory, channel: 'staging', keyId: 'release-staging-test', publicKey
            })).toThrow(/does not match its signed manifest/);
        });

        test('verifyLauncherCandidate returns the validated record', () => {
            const candidate = candidateFor('staging', stagingBytes());
            expect(verifyLauncherCandidate({ candidate, installerPath, channel: 'staging', version: VERSION })).toBe(candidate);
        });
    });

    test('installerFileName is the only accepted installer name', () => {
        expect(installerFileName('3.2.11')).toBe('Microbot-Cut-Launcher-Setup-3.2.11.exe');
        expect(installerFileName('3.2.11-beta.1')).toBe('Microbot-Cut-Launcher-Setup-3.2.11-beta.1.exe');
        for (const bad of ['3.2', '../3.2.11', '3.2.11 ', '3.2.11+build', 'v3.2.11']) {
            expect(() => installerFileName(bad)).toThrow(/version is invalid/);
        }
    });
});
