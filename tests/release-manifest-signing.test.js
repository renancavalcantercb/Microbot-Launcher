const crypto = require('crypto');

const { verifyReleaseManifest } = require('../libs/release-manifest');
const {
    canonicalJson,
    signReleaseManifest
} = require('../libs/release-manifest-signing');

function payload() {
    return {
        schemaVersion: 1,
        channel: 'staging',
        sequence: 8,
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

describe('release manifest signing', () => {
    test('canonical JSON is independent from object insertion order', () => {
        expect(canonicalJson({ z: 1, a: { d: 2, b: 3 } })).toBe(
            canonicalJson({ a: { b: 3, d: 2 }, z: 1 })
        );
    });

    test('creates an envelope accepted by the launcher verifier', () => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048
        });
        const envelope = signReleaseManifest(payload(), {
            keyId: 'release-test',
            privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' })
        });
        const verified = verifyReleaseManifest(envelope, {
            expectedChannel: 'staging',
            trustedKeys: {
                'release-test': publicKey
                    .export({ type: 'spki', format: 'der' })
                    .toString('base64')
            }
        });
        expect(verified).toEqual(payload());
    });

    test('rejects non-RSA signing keys', () => {
        const { privateKey } = crypto.generateKeyPairSync('ed25519');
        expect(() =>
            signReleaseManifest(payload(), {
                keyId: 'release-test',
                privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' })
            })
        ).toThrow('must be RSA');
    });
});
