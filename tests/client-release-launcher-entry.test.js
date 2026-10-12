const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cli = require('../scripts/publish-client-release');
const { bundleDirectory, readAndVerifyBundle } = require('../libs/client-release-publication');
const { launcherObjectKeys } = require('../libs/launcher-release-publication');

// Regression: publishing a client must never drop or change the launcher entry of the live
// manifest, because the site derives the authenticated installer download from that entry.

const LIVE_LAUNCHER = {
    version: '3.2.11',
    minimumSupportedVersion: '3.2.10',
    platforms: {
        'windows-x64': {
            artifactPath: launcherObjectKeys('3.2.11').installer,
            updaterMetadataPath: launcherObjectKeys('3.2.11').updater,
            size: 89139015,
            sha256: 'e'.repeat(64)
        }
    }
};
const OLD_CLIENT = {
    version: 'cut-2.6.30-p16',
    minimumLauncherVersion: '3.2.10',
    artifactPath: 'releases/artifacts/client/cut-2.6.30-p16/microbot-cut-2.6.30-p16.jar',
    size: 10,
    sha256: 'd'.repeat(64)
};

describe('client releases keep the live launcher entry', () => {
    let directory;
    let config;
    let original;
    let live;
    let r2;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-launcher-entry-'));
        const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const privateKeyPath = path.join(directory, 'private.pem');
        fs.writeFileSync(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
        fs.writeFileSync(path.join(directory, 'source.jar'), 'client bytes');
        config = {
            channel: 'staging',
            keyId: 'release-staging-test',
            publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
            privateKeyPath,
            clientRepository: directory,
            minimumLauncherVersion: '3.2.10',
            publicBaseUrl: 'https://cut-staging.example/api/v1/',
            manifestUrl: 'https://cut-staging.example/api/v1/releases/staging/manifest',
            bucket: 'bucket',
            sourceJar: path.join(directory, 'source.jar')
        };
        live = { schemaVersion: 1, channel: 'staging', sequence: 4, publishedAt: '2026-10-10T00:00:00Z', launcher: LIVE_LAUNCHER, client: OLD_CLIENT };
        r2 = new Map();
        original = { ...cli.deps };
        Object.assign(cli.deps, {
            workRoot: path.join(directory, 'work'),
            liveManifest: jest.fn(async () => live),
            runGradleBuild: jest.fn(),
            gitCommit: jest.fn(() => 'c'.repeat(40)),
            gitDirty: jest.fn(() => false),
            fetchResponse: jest.fn(async (url, options = {}) => {
                if (options.method === 'HEAD') return new Response(null, { status: 404 });
                return new Response(Buffer.from('client bytes'), { status: 200 });
            }),
            r2Put: jest.fn((cfg, key, file) => { r2.set(key, fs.readFileSync(file)); }),
            r2Get: jest.fn((cfg, key, destination, { allowMissing } = {}) => {
                if (!r2.has(key)) {
                    if (allowMissing) return false;
                    throw new Error('missing');
                }
                fs.writeFileSync(destination, r2.get(key));
                return true;
            })
        });
        jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        Object.assign(cli.deps, original);
        jest.restoreAllMocks();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const options = (sequence, extra = {}) => ({ version: 'cut-2.6.30-p17', sequence, 'skip-build': true, ...extra });
    const bundle = (sequence) => readAndVerifyBundle({
        outputDirectory: bundleDirectory(cli.deps.workRoot, 'staging', 'cut-2.6.30-p17', sequence),
        channel: 'staging',
        keyId: config.keyId,
        publicKey: config.publicKey
    });

    test('prepare carries the live launcher entry into the signed payload', async () => {
        await cli.prepare(config, options(5));
        expect(bundle(5).payload.launcher).toEqual(LIVE_LAUNCHER);
        expect(bundle(5).payload.client.version).toBe('cut-2.6.30-p17');
    });

    test('prepare records no launcher when none is live', async () => {
        live = { ...live, launcher: null };
        await cli.prepare(config, options(5));
        expect(bundle(5).payload.launcher).toBeNull();
    });

    test('a rollback also carries the live launcher entry', async () => {
        await cli.prepare(config, options(5));
        await cli.prepareRollback(config, { version: 'cut-2.6.30-p17', 'source-sequence': 5, sequence: 6 });
        expect(bundle(6).payload.launcher).toEqual(LIVE_LAUNCHER);
    });

    test('stage accepts a bundle that matches the live launcher', async () => {
        await cli.prepare(config, options(5));
        await cli.stage(config, options(5));
        expect(cli.deps.r2Put).toHaveBeenCalled();
    });

    test('stage refuses a bundle prepared before the launcher was published', async () => {
        live = { ...live, launcher: null };
        await cli.prepare(config, options(5));
        live = { ...live, launcher: LIVE_LAUNCHER, sequence: 4 };
        await expect(cli.stage(config, options(5))).rejects.toThrow('live launcher entry');
        expect(cli.deps.r2Put).not.toHaveBeenCalled();
    });

    test('stage refuses a bundle that would change the live launcher', async () => {
        await cli.prepare(config, options(5));
        live = {
            ...live,
            launcher: { ...LIVE_LAUNCHER, version: '3.2.12' }
        };
        await expect(cli.stage(config, options(5))).rejects.toThrow('live launcher entry');
        expect(cli.deps.r2Put).not.toHaveBeenCalled();
    });

    test('promote refuses when the live launcher changed after staging', async () => {
        await cli.prepare(config, options(5));
        await cli.stage(config, options(5));
        cli.deps.r2Put.mockClear();
        live = { ...live, launcher: null };
        await expect(cli.promote(config, { ...options(5), 'confirm-promote': true })).rejects.toThrow('live launcher entry');
        expect(cli.deps.r2Put).not.toHaveBeenCalled();
    });
});
