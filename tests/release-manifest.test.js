const crypto = require('crypto');

const { verifyReleaseManifest } = require('../libs/release-manifest');

function fixture(overrides = {}) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048
    });
    const payload = {
        schemaVersion: 1,
        channel: 'staging',
        sequence: 7,
        publishedAt: '2026-10-10T00:00:00.000Z',
        launcher: {
            version: '3.2.11',
            minimumSupportedVersion: '3.2.10',
            platforms: {
                'windows-x64': {
                    artifactPath:
                        'releases/artifacts/launcher/3.2.11/windows/setup.exe',
                    updaterMetadataPath:
                        'releases/artifacts/launcher/3.2.11/windows/latest.yml',
                    size: 123,
                    sha256: 'a'.repeat(64)
                }
            }
        },
        client: {
            version: '2.6.31-cut.1',
            minimumLauncherVersion: '3.2.10',
            artifactPath:
                'releases/artifacts/client/2.6.31-cut.1/microbot-cut-2.6.31-cut.1.jar',
            size: 456,
            sha256: 'b'.repeat(64)
        },
        ...overrides
    };
    const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
    return {
        payload,
        trustedKeys: {
            'release-test': publicKey
                .export({ type: 'spki', format: 'der' })
                .toString('base64')
        },
        envelope: {
            keyId: 'release-test',
            payload: payloadBytes.toString('base64'),
            signature: crypto
                .sign('RSA-SHA256', payloadBytes, privateKey)
                .toString('base64')
        }
    };
}

describe('release manifest verification', () => {
    test('accepts a valid signed staging manifest', () => {
        const value = fixture();
        expect(
            verifyReleaseManifest(value.envelope, {
                expectedChannel: 'staging',
                trustedKeys: value.trustedKeys
            })
        ).toEqual(value.payload);
    });

    test('rejects a payload modified after signing', () => {
        const value = fixture();
        const modified = {
            ...value.payload,
            sequence: value.payload.sequence + 1
        };
        value.envelope.payload = Buffer.from(JSON.stringify(modified)).toString('base64');
        expect(() =>
            verifyReleaseManifest(value.envelope, {
                expectedChannel: 'staging',
                trustedKeys: value.trustedKeys
            })
        ).toThrow('signature is invalid');
    });

    test('rejects a valid signature from an unknown key', () => {
        const value = fixture();
        expect(() =>
            verifyReleaseManifest(value.envelope, {
                expectedChannel: 'staging',
                trustedKeys: {}
            })
        ).toThrow('not trusted');
    });

    test('rejects a manifest for another channel', () => {
        const value = fixture();
        expect(() =>
            verifyReleaseManifest(value.envelope, {
                expectedChannel: 'production',
                trustedKeys: value.trustedKeys
            })
        ).toThrow('channel does not match');
    });

    test('accepts a client-only release with no launcher artifact', () => {
        const value = fixture({ launcher: null });
        expect(
            verifyReleaseManifest(value.envelope, {
                expectedChannel: 'staging',
                trustedKeys: value.trustedKeys
            })
        ).toMatchObject({ launcher: null, client: value.payload.client });
    });

    test('rejects unsafe artifact paths even when signed', () => {
        const value = fixture({
            client: {
                version: '2.6.31-cut.1',
                minimumLauncherVersion: '3.2.10',
                artifactPath: '../client.jar',
                size: 456,
                sha256: 'b'.repeat(64)
            }
        });
        expect(() =>
            verifyReleaseManifest(value.envelope, {
                expectedChannel: 'staging',
                trustedKeys: value.trustedKeys
            })
        ).toThrow('artifactPath');
    });

    test('rejects invalid hashes and byte counts even when signed', () => {
        const value = fixture({
            client: {
                version: '2.6.31-cut.1',
                minimumLauncherVersion: '3.2.10',
                artifactPath: 'releases/artifacts/client/client.jar',
                size: 0,
                sha256: 'not-a-hash'
            }
        });
        expect(() =>
            verifyReleaseManifest(value.envelope, {
                expectedChannel: 'staging',
                trustedKeys: value.trustedKeys
            })
        ).toThrow('size');
    });
});
