const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const {
    downloadVerifiedArtifact
} = require('../libs/verified-artifact-download');

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

describe('verified artifact download', () => {
    let directory;
    let destination;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-release-'));
        destination = path.join(directory, 'microbot-cut-test.jar');
    });

    afterEach(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('streams, verifies, and atomically installs an artifact', async () => {
        const artifact = Buffer.from('verified-client-jar');
        const progress = [];
        const result = await downloadVerifiedArtifact({
            httpClient: jest.fn().mockResolvedValue({ data: Readable.from([artifact]) }),
            url: new URL('https://updates.example/client.jar'),
            destination,
            expectedSize: artifact.length,
            expectedSha256: sha256(artifact),
            onProgress: (event) => progress.push(event)
        });

        expect(result).toMatchObject({
            bytes: artifact.length,
            sha256: sha256(artifact),
            path: destination,
            reused: false
        });
        expect(fs.readFileSync(destination)).toEqual(artifact);
        expect(progress.at(-1)).toEqual({ bytes: artifact.length, total: artifact.length });
        expect(fs.readdirSync(directory).some((name) => name.endsWith('.part'))).toBe(false);
    });

    test('deletes the partial file when verification fails', async () => {
        const artifact = Buffer.from('corrupted-client-jar');
        await expect(
            downloadVerifiedArtifact({
                httpClient: jest.fn().mockResolvedValue({ data: Readable.from([artifact]) }),
                url: new URL('https://updates.example/client.jar'),
                destination,
                expectedSize: artifact.length,
                expectedSha256: 'a'.repeat(64)
            })
        ).rejects.toThrow('SHA-256');

        expect(fs.existsSync(destination)).toBe(false);
        expect(fs.readdirSync(directory)).toEqual([]);
    });

    test('does not replace a conflicting existing artifact', async () => {
        const existing = Buffer.from('user-file');
        const expected = Buffer.from('release-file');
        fs.writeFileSync(destination, existing);
        const httpClient = jest.fn();

        await expect(
            downloadVerifiedArtifact({
                httpClient,
                url: new URL('https://updates.example/client.jar'),
                destination,
                expectedSize: expected.length,
                expectedSha256: sha256(expected)
            })
        ).rejects.toThrow('existing artifact');

        expect(fs.readFileSync(destination)).toEqual(existing);
        expect(httpClient).not.toHaveBeenCalled();
    });

    test('reuses an existing artifact that matches the signed manifest', async () => {
        const artifact = Buffer.from('already-verified');
        fs.writeFileSync(destination, artifact);
        const httpClient = jest.fn();

        const result = await downloadVerifiedArtifact({
            httpClient,
            url: new URL('https://updates.example/client.jar'),
            destination,
            expectedSize: artifact.length,
            expectedSha256: sha256(artifact)
        });

        expect(result.reused).toBe(true);
        expect(httpClient).not.toHaveBeenCalled();
    });

    test('rejects transport URLs that are not HTTPS', async () => {
        await expect(
            downloadVerifiedArtifact({
                httpClient: jest.fn(),
                url: new URL('http://updates.example/client.jar'),
                destination,
                expectedSize: 1,
                expectedSha256: 'a'.repeat(64)
            })
        ).rejects.toThrow('HTTPS');
    });
});
