const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    bundleDirectory,
    prepareClientRelease,
    readAndVerifyBundle,
    requireNewerSequence
} = require('../libs/client-release-publication');
const { parseArguments } = require('../scripts/publish-client-release');

describe('client release publication', () => {
    let directory;
    let privateKeyPem;
    let publicKey;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-release-test-'));
        const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
        publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    });

    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    test('prepares and verifies an immutable signed client bundle', () => {
        const sourceJar = path.join(directory, 'source.jar');
        fs.writeFileSync(sourceJar, 'client bytes');
        const outputDirectory = bundleDirectory(directory, 'staging', 'cut-2.6.30-p17', 3);
        const prepared = prepareClientRelease({
            sourceJar,
            outputDirectory,
            channel: 'staging',
            version: 'cut-2.6.30-p17',
            sequence: 3,
            minimumLauncherVersion: '3.2.10',
            keyId: 'release-staging-test',
            privateKeyPem,
            publicKey,
            publishedAt: '2026-10-10T12:00:00.000Z',
            sourceCommit: 'abc123'
        });
        const verified = readAndVerifyBundle({
            outputDirectory,
            channel: 'staging',
            keyId: 'release-staging-test',
            publicKey
        });

        expect(prepared.payload.client.version).toBe('cut-2.6.30-p17');
        expect(verified.payload.client.sha256).toBe(prepared.payload.client.sha256);
        expect(verified.metadata.sourceCommit).toBe('abc123');
        expect(verified.payload.client.artifactPath).toBe(
            'releases/artifacts/client/cut-2.6.30-p17/microbot-cut-2.6.30-p17.jar'
        );
    });

    test('refuses to overwrite an existing release bundle', () => {
        const sourceJar = path.join(directory, 'source.jar');
        const outputDirectory = path.join(directory, 'existing');
        fs.writeFileSync(sourceJar, 'client bytes');
        fs.mkdirSync(outputDirectory);
        expect(() => prepareClientRelease({
            sourceJar,
            outputDirectory,
            channel: 'staging',
            version: 'cut-2.6.30-p17',
            sequence: 3,
            minimumLauncherVersion: '3.2.10',
            keyId: 'release-staging-test',
            privateKeyPem,
            publicKey
        })).toThrow('release bundle already exists');
    });

    test('detects artifact tampering', () => {
        const sourceJar = path.join(directory, 'source.jar');
        fs.writeFileSync(sourceJar, 'client bytes');
        const outputDirectory = path.join(directory, 'bundle');
        prepareClientRelease({
            sourceJar,
            outputDirectory,
            channel: 'staging',
            version: 'cut-2.6.30-p17',
            sequence: 3,
            minimumLauncherVersion: '3.2.10',
            keyId: 'release-staging-test',
            privateKeyPem,
            publicKey
        });
        fs.appendFileSync(path.join(outputDirectory, 'microbot-cut-2.6.30-p17.jar'), 'tampered');
        expect(() => readAndVerifyBundle({
            outputDirectory,
            channel: 'staging',
            keyId: 'release-staging-test',
            publicKey
        })).toThrow(/size|SHA-256/);
    });

    test('requires a monotonically increasing channel sequence', () => {
        expect(() => requireNewerSequence({ sequence: 2 }, { sequence: 2 }))
            .toThrow('must be greater than live sequence 2');
        expect(() => requireNewerSequence({ sequence: 3 }, { sequence: 2 })).not.toThrow();
    });

    test('parses explicit safe release commands', () => {
        expect(parseArguments([
            'promote', '--version', 'cut-2.6.30-p17', '--sequence', '3', '--confirm-promote'
        ])).toEqual({
            command: 'promote',
            options: {
                version: 'cut-2.6.30-p17',
                sequence: 3,
                'confirm-promote': true
            }
        });
        expect(() => parseArguments(['stage', '--version', '../bad', '--sequence', '3']))
            .toThrow('client version is invalid');
    });
});
