const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { VerifiedClientReleaseStore } = require('../libs/verified-client-release-store');
const { ClientReleaseHealth } = require('../libs/client-release-health');

describe('client release health and rollback', () => {
    let directory;
    let store;
    let health;
    let onChanged;
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    beforeEach(() => {
        jest.useFakeTimers();
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-client-health-'));
        store = new VerifiedClientReleaseStore({ fs, productDataDir: directory, log });
        onChanged = jest.fn();
        health = new ClientReleaseHealth({
            fs,
            microbotDir: directory,
            releaseStore: store,
            log,
            timeoutMs: 1000,
            onChanged
        });
        fs.writeFileSync(
            path.join(directory, 'resource_versions.json'),
            JSON.stringify({ client: 'cut-new', client_ram: '4g' })
        );
    });

    afterEach(() => {
        jest.useRealTimers();
        fs.rmSync(directory, { recursive: true, force: true });
        jest.clearAllMocks();
    });

    function record(version) {
        const bytes = Buffer.from(version);
        store.record({
            version,
            fileName: `microbot-${version}.jar`,
            channel: 'staging',
            sequence: version === 'cut-old' ? 1 : 2,
            size: bytes.length,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            artifactPath: `releases/artifacts/client/${version}/client.jar`,
            signedEnvelope: { test: version }
        });
    }

    test('promotes an acknowledged release to last-known-good', () => {
        record('cut-old');
        expect(health.begin('cut-old')).toBe(true);
        expect(store.get('cut-old').health).toBe('pending');

        expect(health.healthy('cut-old')).toBe(true);

        expect(store.get('cut-old').health).toBe('healthy');
        expect(store.read().lastKnownGoodVersion).toBe('cut-old');
        expect(onChanged).toHaveBeenLastCalledWith(
            expect.objectContaining({ lastKnownGoodVersion: 'cut-old' })
        );
    });

    test('selects the last-known-good release after a health timeout', () => {
        record('cut-old');
        health.begin('cut-old');
        health.healthy('cut-old');
        record('cut-new');
        health.begin('cut-new');

        jest.advanceTimersByTime(1001);

        expect(store.get('cut-new').health).toBe('failed');
        expect(JSON.parse(fs.readFileSync(
            path.join(directory, 'resource_versions.json'),
            'utf8'
        ))).toMatchObject({
            client: 'cut-old',
            version_pref: 'cut-old',
            client_ram: '4g'
        });
    });
});
