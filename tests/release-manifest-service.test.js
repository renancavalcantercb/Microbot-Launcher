const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ReleaseManifestService } = require('../libs/release-manifest-service');
const { signReleaseManifest } = require('../libs/release-manifest-signing');

function releasePayload(sequence) {
    return {
        schemaVersion: 1,
        channel: 'staging',
        sequence,
        publishedAt: '2026-10-10T00:00:00.000Z',
        launcher: {
            version: '3.2.11',
            minimumSupportedVersion: '3.2.10',
            platforms: {
                'windows-x64': {
                    artifactPath: 'releases/artifacts/launcher/3.2.11/windows/setup.exe',
                    updaterMetadataPath: 'releases/artifacts/launcher/3.2.11/windows/latest.yml',
                    size: 123,
                    sha256: 'a'.repeat(64)
                }
            }
        },
        client: {
            version: '2.6.31-cut.1',
            minimumLauncherVersion: '3.2.10',
            artifactPath: 'releases/artifacts/client/2.6.31-cut.1/client.jar',
            size: 456,
            sha256: 'b'.repeat(64)
        }
    };
}

describe('release manifest service', () => {
    let directory;
    let privateKey;
    let settings;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-manifest-state-'));
        const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
        settings = {
            enabled: true,
            channel: 'staging',
            manifestUrl: 'https://cut.example/releases/staging/manifest.json',
            artifactBaseUrl: 'https://cut.example/',
            trustedKeys: {
                'release-test': keys.publicKey
                    .export({ type: 'spki', format: 'der' })
                    .toString('base64')
            }
        };
    });

    afterEach(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    function envelope(sequence) {
        return signReleaseManifest(releasePayload(sequence), {
            keyId: 'release-test',
            privateKeyPem: privateKey
        });
    }

    function service(sequence) {
        return new ReleaseManifestService({
            axios: { get: jest.fn().mockResolvedValue({ data: envelope(sequence) }) },
            productDataDir: directory,
            settings,
            log: { error: jest.fn() }
        });
    }

    test('fetches, verifies, and records the highest accepted sequence', async () => {
        await expect(service(10).fetchCurrent()).resolves.toMatchObject({ sequence: 10 });
        expect(JSON.parse(fs.readFileSync(path.join(directory, 'release-update-state.json'))))
            .toMatchObject({ staging: { highestSequence: 10 } });
    });

    test('updates state when a newer signed sequence is accepted', async () => {
        await service(10).fetchCurrent();
        await service(11).fetchCurrent();
        expect(JSON.parse(fs.readFileSync(path.join(directory, 'release-update-state.json')))
            .staging.highestSequence).toBe(11);
    });

    test('rejects replay of an older valid signed manifest', async () => {
        await service(10).fetchCurrent();
        await expect(service(9).fetchCurrent()).rejects.toThrow('older than accepted');
    });

    test('uses the locally accepted signed release when the network is unavailable', async () => {
        await service(10).fetchCurrent();
        const offline = new ReleaseManifestService({
            axios: { get: jest.fn().mockRejectedValue(new Error('offline')) },
            productDataDir: directory,
            settings,
            log: { error: jest.fn(), warn: jest.fn() }
        });

        await expect(offline.fetchCurrent()).resolves.toMatchObject({ sequence: 10 });
        expect(offline.getLocallyAccepted()).toMatchObject({ sequence: 10 });
    });

    test('resolves signed artifact paths against the configured HTTPS base', () => {
        expect(service(10).resolveArtifactUrl('releases/artifacts/client/client.jar').toString())
            .toBe('https://cut.example/releases/artifacts/client/client.jar');
    });
});
