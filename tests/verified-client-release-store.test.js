const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
    VerifiedClientReleaseStore,
    STORE_FILE
} = require('../libs/verified-client-release-store');

describe('verified client release store', () => {
    let directory;
    let store;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-client-release-store-'));
        store = new VerifiedClientReleaseStore({
            fs,
            productDataDir: directory,
            log: { error: jest.fn() },
            now: () => new Date('2026-10-10T05:00:00.000Z')
        });
    });

    afterEach(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    function metadata(bytes) {
        return {
            version: 'cut-2.6.30-p15',
            fileName: 'microbot-cut-2.6.30-p15.jar',
            channel: 'staging',
            sequence: 1,
            size: bytes.length,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            artifactPath: 'releases/artifacts/client/cut-2.6.30-p15/client.jar'
        };
    }

    test('records trusted metadata atomically and verifies the local bytes', async () => {
        const bytes = Buffer.from('verified-client');
        const filePath = path.join(directory, 'microbot-cut-2.6.30-p15.jar');
        fs.writeFileSync(filePath, bytes);

        const entry = store.record(metadata(bytes));

        expect(store.get(entry.version)).toMatchObject({
            sha256: entry.sha256,
            verifiedAt: '2026-10-10T05:00:00.000Z'
        });
        await expect(store.verifyFile(entry, filePath)).resolves.toMatchObject({
            bytes: bytes.length,
            sha256: entry.sha256
        });
        expect(fs.existsSync(path.join(directory, STORE_FILE))).toBe(true);
    });

    test('blocks a locally modified client', async () => {
        const original = Buffer.from('verified-client');
        const filePath = path.join(directory, 'microbot-cut-2.6.30-p15.jar');
        const entry = store.record(metadata(original));
        fs.writeFileSync(filePath, Buffer.from('modified-client'));

        await expect(store.verifyFile(entry, filePath)).rejects.toThrow(
            'failed local integrity verification'
        );
    });

    test('returns renderer-safe health without signed metadata or hashes', () => {
        const bytes = Buffer.from('verified-client');
        const entry = store.record({
            ...metadata(bytes),
            signedEnvelope: { privateDetail: 'not-for-renderer' }
        });
        store.markPending(entry.version);
        store.markHealthy(entry.version);

        const status = store.status();

        expect(status.lastKnownGoodVersion).toBe(entry.version);
        expect(store.status('staging').lastKnownGoodVersion).toBe(entry.version);
        expect(store.status('production').lastKnownGoodVersion).toBeNull();
        expect(status.releases[0]).toMatchObject({
            version: entry.version,
            channel: 'staging',
            health: 'healthy',
            launchAttempts: 1
        });
        expect(status.releases[0].signedEnvelope).toBeUndefined();
        expect(status.releases[0].sha256).toBeUndefined();
    });

    test('keeps last-known-good releases isolated by channel', () => {
        const stagingBytes = Buffer.from('staging-client');
        const productionBytes = Buffer.from('production-client');
        store.record(metadata(stagingBytes));
        store.markHealthy('cut-2.6.30-p15');
        store.record({
            ...metadata(productionBytes),
            version: 'cut-2.6.30',
            fileName: 'microbot-cut-2.6.30.jar',
            channel: 'production',
            artifactPath: 'releases/artifacts/client/cut-2.6.30/client.jar'
        });
        store.markHealthy('cut-2.6.30');

        expect(store.status('staging').lastKnownGoodVersion).toBe('cut-2.6.30-p15');
        expect(store.status('production').lastKnownGoodVersion).toBe('cut-2.6.30');
    });

    test('recovers from the previous atomic store file', () => {
        const bytes = Buffer.from('verified-client');
        const entry = store.record(metadata(bytes));
        fs.renameSync(
            path.join(directory, STORE_FILE),
            path.join(directory, `${STORE_FILE}.previous`)
        );

        expect(store.get(entry.version)).toMatchObject({ sha256: entry.sha256 });
    });
});
