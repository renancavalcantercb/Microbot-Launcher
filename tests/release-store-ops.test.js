const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ops = require('../libs/release-store-ops');
const probe = require('../scripts/probe-r2-conditional-writes');
const { signReleaseManifest } = require('../libs/release-manifest-signing');
const { createMemoryR2 } = require('./helpers/memory-r2');

const BUCKET = 'bucket';

describe('release store operations', () => {
    let directory;
    let memory;
    let store;
    let config;
    let privateKeyPem;

    const payload = (sequence) => ({
        schemaVersion: 1,
        channel: 'staging',
        sequence,
        publishedAt: '2026-10-10T00:00:00Z',
        launcher: null,
        client: { version: 'cut-1', minimumLauncherVersion: '3.2.10', artifactPath: 'releases/artifacts/client/cut-1/microbot-cut-1.jar', size: 1, sha256: 'a'.repeat(64) }
    });
    const manifestBytes = (sequence) => Buffer.from(`${JSON.stringify(signReleaseManifest(payload(sequence), { keyId: config.keyId, privateKeyPem }), null, 2)}\n`);
    const file = (name, bytes) => {
        const target = path.join(directory, name);
        fs.writeFileSync(target, bytes);
        return target;
    };

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-store-ops-'));
        const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
        config = { channel: 'staging', keyId: 'k', publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
        memory = createMemoryR2();
        store = memory.store(BUCKET);
    });

    afterEach(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    describe('reading the live manifest', () => {
        test('returns the verified payload with the bytes and the ETag, or null when there is none', async () => {
            expect(await ops.readLiveManifest(store, config)).toBeNull();
            memory.seed(BUCKET, ops.manifestKey('staging'), manifestBytes(7));
            const live = await ops.readLiveManifest(store, config);
            expect(live.payload.sequence).toBe(7);
            expect(live.etag).toBe(memory.etag(BUCKET, 'releases/staging/manifest.json'));
            expect(ops.nextSequence(live)).toBe(8);
            expect(ops.nextSequence(null)).toBe(1);
        });

        test('refuses a manifest that is not signed by the channel key', async () => {
            const bytes = JSON.parse(manifestBytes(3).toString('utf8'));
            bytes.payload = Buffer.from(JSON.stringify({ ...payload(99) })).toString('base64');
            memory.seed(BUCKET, ops.manifestKey('staging'), Buffer.from(JSON.stringify(bytes)));
            await expect(ops.readLiveManifest(store, config)).rejects.toThrow();
        });
    });

    describe('bundle base', () => {
        const metadataOf = (overrides) => ({ base: { etag: '"e"', sequence: 4 }, ...overrides });

        test('is recorded in release.json and read back', async () => {
            fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify({ version: 'x' }));
            memory.seed(BUCKET, ops.manifestKey('staging'), manifestBytes(4));
            ops.recordBase(directory, await ops.readLiveManifest(store, config));
            const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8'));
            expect(metadata.version).toBe('x');
            expect(ops.requireBase(metadata)).toEqual({ etag: memory.etag(BUCKET, 'releases/staging/manifest.json'), sequence: 4 });
        });

        test.each([
            ['no base', {}],
            ['an empty ETag', { base: { etag: '', sequence: 4 } }],
            ['an absent ETag for a channel that had a manifest', { base: { etag: null, sequence: 4 } }],
            ['a negative sequence', { base: { etag: '"e"', sequence: -1 } }],
            ['a fractional sequence', { base: { etag: '"e"', sequence: 1.5 } }]
        ])('refuses %s', (_label, bad) => {
            expect(() => ops.requireBase({ ...bad })).toThrow(/prepare it again/);
        });

        test('accepts "absent" only for a channel that had no manifest', () => {
            expect(ops.requireBase({ base: { etag: null, sequence: 0 } })).toEqual({ etag: null, sequence: 0 });
            expect(ops.requireBase(metadataOf({}))).toEqual({ etag: '"e"', sequence: 4 });
        });

        test('a live manifest that is not the base is a conflict that says what is live', async () => {
            memory.seed(BUCKET, ops.manifestKey('staging'), manifestBytes(5));
            const live = await ops.readLiveManifest(store, config);
            expect(() => ops.requireLiveMatchesBase(live, { etag: live.etag, sequence: 5 })).not.toThrow();
            expect(() => ops.requireLiveMatchesBase(live, { etag: '"other"', sequence: 4 })).toThrow(ops.PublicationConflictError);
            expect(() => ops.requireLiveMatchesBase(live, { etag: '"other"', sequence: 4 })).toThrow(/sequence 5.*Prepare a new candidate/s);
            expect(() => ops.requireLiveMatchesBase(null, { etag: '"other"', sequence: 4 })).toThrow(/there is no live manifest/);
            expect(() => ops.requireLiveMatchesBase(null, { etag: null, sequence: 0 })).not.toThrow();
        });
    });

    describe('immutable objects', () => {
        const spec = (name, extra = {}) => ({ key: `releases/x/${name}`, file: file(name, 'payload'), contentType: 'text/plain', name, ...extra });

        test('are written once, only when absent, and read back', async () => {
            const result = await ops.putImmutable(store, spec('a'));
            expect(result).toEqual({ action: 'uploaded', size: 7 });
            expect(memory.log.filter((entry) => entry.op === 'putIfAbsent')).toHaveLength(1);
        });

        test('a conflict (the object appeared between the check and the write) is verified, never replaced', async () => {
            memory.before = (op, bucket, key) => {
                if (op === 'putIfAbsent') {
                    memory.before = null;
                    memory.seed(bucket, key, Buffer.from('payload'));
                }
            };
            await expect(ops.putImmutable(store, spec('b'))).rejects.toThrow(/was created by another publication while this one was staging/);
            await expect(ops.putImmutable(store, spec('b', { resume: true }))).resolves.toEqual({ action: 'verified', size: 7 });
            expect(memory.writes()).toHaveLength(1);
        });

        test('a conflict with other bytes is refused', async () => {
            memory.before = (op, bucket, key) => {
                if (op === 'putIfAbsent') {
                    memory.before = null;
                    memory.seed(bucket, key, Buffer.from('another'));
                }
            };
            await expect(ops.putImmutable(store, spec('c', { resume: true }))).rejects.toThrow(/different bytes between the check and the write/);
            expect(memory.bytes(BUCKET, 'releases/x/c').toString()).toBe('another');
        });

        test('a reused object must exist and match; it is never written', async () => {
            await expect(ops.putImmutable(store, spec('d', { reuse: true }))).rejects.toThrow(/no longer available in R2/);
            memory.seed(BUCKET, 'releases/x/d', Buffer.from('payload'));
            await expect(ops.putImmutable(store, spec('d', { reuse: true }))).resolves.toMatchObject({ action: 'verified' });
            expect(memory.writes()).toEqual([]);
        });

        test('a dry run reports and does not write', async () => {
            await expect(ops.putImmutable(store, spec('e', { dryRun: true }))).resolves.toEqual({ action: 'would-upload', size: 7 });
            expect(memory.writes()).toEqual([]);
        });
    });

    describe('promoting the manifest', () => {
        const key = 'releases/staging/manifest.json';
        const base = async () => {
            memory.seed(BUCKET, key, manifestBytes(4));
            const live = await ops.readLiveManifest(store, config);
            return { etag: live.etag, sequence: 4 };
        };

        test('writes under If-Match and reads the result back', async () => {
            const state = await base();
            const result = await ops.promoteManifest(store, config, { bytes: manifestBytes(5), base: state });
            expect(result.recovered).toBe(false);
            expect((await ops.readLiveManifest(store, config)).payload.sequence).toBe(5);
            expect(memory.writes()).toEqual([expect.objectContaining({ op: 'putIfMatch', condition: { ifMatch: state.etag } })]);
        });

        test('an absent base is written under If-None-Match: *', async () => {
            await ops.promoteManifest(store, config, { bytes: manifestBytes(1), base: { etag: null, sequence: 0 } });
            expect(memory.writes()).toEqual([expect.objectContaining({ op: 'putIfAbsent' })]);
        });

        test('a conflict is reported with the state that is live now, and is never retried', async () => {
            const state = await base();
            memory.before = (op) => {
                if (op === 'putIfMatch') {
                    memory.before = null;
                    memory.seed(BUCKET, key, manifestBytes(9));
                }
            };
            const error = await ops.promoteManifest(store, config, { bytes: manifestBytes(5), base: state }).catch((failure) => failure);
            expect(error).toBeInstanceOf(ops.PublicationConflictError);
            expect(error.live.payload.sequence).toBe(9);
            expect(memory.log.filter((entry) => entry.op === 'putIfMatch')).toHaveLength(1);
        });

        test('a manifest that was created while the base was "absent" is a conflict', async () => {
            memory.before = (op) => {
                if (op === 'putIfAbsent') {
                    memory.before = null;
                    memory.seed(BUCKET, key, manifestBytes(1));
                }
            };
            await expect(ops.promoteManifest(store, config, { bytes: manifestBytes(1), base: { etag: null, sequence: 0 } }))
                .rejects.toThrow(ops.PublicationConflictError);
        });

        test('a lost answer is classified by looking at R2: applied, not applied, or overtaken', async () => {
            const state = await base();
            const bytes = manifestBytes(5);
            memory.failNext('put', key, { apply: true });
            await expect(ops.promoteManifest(store, config, { bytes, base: state })).resolves.toMatchObject({ recovered: true });

            memory.seed(BUCKET, key, manifestBytes(4));
            const again = await ops.readLiveManifest(store, config);
            memory.failNext('put', key);
            await expect(ops.promoteManifest(store, config, { bytes, base: { etag: again.etag, sequence: 4 } })).rejects.toThrow(ops.WriteNotAppliedError);

            memory.failNext('put', key);
            memory.before = (op) => {
                if (op === 'putIfMatch') {
                    memory.before = null;
                    memory.seed(BUCKET, key, manifestBytes(8));
                }
            };
            await expect(ops.promoteManifest(store, config, { bytes, base: { etag: again.etag, sequence: 4 } })).rejects.toThrow(ops.PublicationConflictError);
        });

        test('a write that reads back as something else is reported', async () => {
            const state = await base();
            memory.corruptNext(key);
            await expect(ops.promoteManifest(store, config, { bytes: manifestBytes(5), base: state })).rejects.toThrow(/not the one written/);
        });
    });

    describe('the conditional-write probe', () => {
        test('passes on a bucket that enforces both preconditions, and touches only the probe prefix', async () => {
            const { key } = await ops.probeConditionalWrites(store, 'staging', 'id1');
            expect(key).toBe('releases/staging/probes/conditional-id1.txt');
            expect(memory.keys(BUCKET)).toEqual([key]);
            expect(memory.bytes(BUCKET, key).toString()).toBe('four');
        });

        test.each([
            ['If-None-Match: * ignored', (real) => ({ ...real, putIfAbsent: async (key, bytes) => { memory.seed(BUCKET, key, bytes); return { status: 'created', etag: '"x"' }; } })],
            ['If-Match ignored', (real) => ({ ...real, putIfMatch: async (key, bytes) => { memory.seed(BUCKET, key, bytes); return { status: 'created', etag: '"x"' }; } })]
        ])('fails closed when %s', async (_label, wrap) => {
            await expect(ops.probeConditionalWrites(wrap(store), 'staging', 'id2')).rejects.toThrow(/not enforced by this bucket.*Do not publish/s);
        });

        test('the command needs an explicit confirmation and uses a writable store', async () => {
            await expect(probe.main(['--config', 'x'])).rejects.toThrow(/--confirm-probe/);
            await expect(probe.main(['--confirm-probe', '--bogus'])).rejects.toThrow(/unexpected argument/);
        });
    });

    describe('no unconditional write exists', () => {
        const root = path.resolve(__dirname, '..');
        const sources = ['libs/r2-store.js', 'libs/release-store-ops.js', 'libs/release-publication-io.js', 'scripts/publish-client-release.js', 'scripts/publish-launcher-release.js', 'scripts/probe-r2-conditional-writes.js'];

        test('the publication code has no wrangler, no r2Put and no put without a precondition', () => {
            for (const relative of sources) {
                const text = fs.readFileSync(path.join(root, relative), 'utf8');
                expect(text.replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/wrangler\.js|r2 object put|--force/);
                expect(text).not.toMatch(/\br2Put\b|\br2Get\b/);
                expect(text).not.toMatch(/method:\s*'PUT'/);
            }
            const transport = fs.readFileSync(path.join(root, 'libs/r2-store.js'), 'utf8');
            expect(transport.match(/request\('PUT'/g)).toHaveLength(1);
        });
    });
});
