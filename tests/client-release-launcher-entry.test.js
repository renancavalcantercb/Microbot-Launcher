const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cli = require('../scripts/publish-client-release');
const { bundleDirectory, readAndVerifyBundle } = require('../libs/client-release-publication');
const { launcherObjectKeys } = require('../libs/launcher-release-publication');
const ops = require('../libs/release-store-ops');
const { createR2Store } = require('../libs/r2-store');
const { verifyReleaseManifest } = require('../libs/release-manifest');
const { signReleaseManifest } = require('../libs/release-manifest-signing');
const { createMemoryFetch, createMemoryR2 } = require('./helpers/memory-r2');

// The client publication CLI against an in-memory R2 with real ETag and conditional-write semantics.
// The regression it guards: publishing a client must never drop or change the launcher entry of the
// live manifest (the site derives the authenticated installer download from it), even when a launcher
// release lands while the client release is being prepared, staged or promoted.

const BUCKET = 'bucket';
const MANIFEST = 'releases/staging/manifest.json';
const VERSION = 'cut-2.6.30-p17';
const LIVE_LAUNCHER = {
    version: '3.2.11',
    minimumSupportedVersion: '3.2.11',
    platforms: {
        'windows-x64': {
            artifactPath: launcherObjectKeys('3.2.11').installer,
            updaterMetadataPath: launcherObjectKeys('3.2.11').updater,
            size: 89139015,
            sha256: 'e'.repeat(64)
        }
    }
};
const NEWER_LAUNCHER = { ...LIVE_LAUNCHER, version: '3.2.12' };
const OLD_CLIENT = {
    version: 'cut-2.6.30-p16',
    minimumLauncherVersion: '3.2.10',
    artifactPath: 'releases/artifacts/client/cut-2.6.30-p16/microbot-cut-2.6.30-p16.jar',
    size: 10,
    sha256: 'd'.repeat(64)
};

describe('client publication CLI', () => {
    let directory;
    let config;
    let original;
    let memory;
    let keys;
    let output;

    function seedManifest({ sequence, launcher = LIVE_LAUNCHER, client = OLD_CLIENT }) {
        const payload = { schemaVersion: 1, channel: 'staging', sequence, publishedAt: '2026-10-10T00:00:00Z', launcher, client };
        const envelope = signReleaseManifest(payload, { keyId: config.keyId, privateKeyPem: keys.privateKeyPem });
        memory.seed(BUCKET, MANIFEST, Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`));
    }

    function liveOf() {
        const bytes = memory.bytes(BUCKET, MANIFEST);
        if (!bytes) return null;
        return verifyReleaseManifest(JSON.parse(bytes.toString('utf8')), {
            expectedChannel: 'staging',
            trustedKeys: { [config.keyId]: config.publicKey }
        });
    }

    // The bundle is pointed at the manifest as it is now, to reach the checks behind the base-ETag one.
    function rebase(sequence) {
        const file = path.join(bundleDirectory(cli.deps.workRoot, 'staging', VERSION, sequence), 'release.json');
        const release = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, JSON.stringify({ ...release, base: { etag: memory.etag(BUCKET, MANIFEST), sequence: liveOf().sequence } }));
    }

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-client-cli-'));
        const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        keys = { privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
        const privateKeyPath = path.join(directory, 'private.pem');
        fs.writeFileSync(privateKeyPath, keys.privateKeyPem);
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
            bucket: BUCKET,
            sourceJar: path.join(directory, 'source.jar')
        };
        memory = createMemoryR2();
        seedManifest({ sequence: 4 });
        original = { ...cli.deps };
        Object.assign(cli.deps, {
            workRoot: path.join(directory, 'work'),
            liveManifest: jest.fn(async () => liveOf()),
            runGradleBuild: jest.fn(),
            gitCommit: jest.fn(() => 'c'.repeat(40)),
            gitDirty: jest.fn(() => false),
            // the public edge: serves the client artifact and answers the Range probe
            fetchResponse: jest.fn(async (url, options = {}) => {
                const key = new URL(url).pathname.replace('/api/v1/', '');
                const bytes = memory.bytes(BUCKET, key);
                if (!bytes) return new Response(null, { status: 404 });
                if (options.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(bytes.length) } });
                if (options.headers && options.headers.Range) {
                    return new Response(bytes.subarray(0, 1), { status: 206, headers: { 'content-range': `bytes 0-0/${bytes.length}` } });
                }
                return new Response(bytes, { status: 200 });
            }),
            openStore: jest.fn((cfg, { writable = true } = {}) => memory.store(cfg.bucket, { writable }))
        });
        output = [];
        jest.spyOn(process.stdout, 'write').mockImplementation((text) => {
            output.push(String(text));
            return true;
        });
    });

    afterEach(() => {
        Object.assign(cli.deps, original);
        jest.restoreAllMocks();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const options = (sequence, extra = {}) => ({ version: VERSION, sequence, 'skip-build': true, ...extra });
    const bundle = (sequence) => readAndVerifyBundle({
        outputDirectory: bundleDirectory(cli.deps.workRoot, 'staging', VERSION, sequence),
        channel: 'staging',
        keyId: config.keyId,
        publicKey: config.publicKey
    });
    const puts = () => memory.log.filter((entry) => entry.op.startsWith('put'));
    const promoteOptions = (sequence, extra = {}) => options(sequence, { 'confirm-promote': true, ...extra });

    describe('argument parsing', () => {
        const parse = (...argv) => cli.parseArguments(argv);

        test('the sequence of a new release is never typed', () => {
            expect(parse('prepare', '--version', VERSION).options.sequence).toBeUndefined();
            expect(() => parse('prepare', '--version', VERSION, '--sequence', '5')).toThrow(/computes the sequence from the live manifest/);
            expect(() => parse('prepare-rollback', '--version', VERSION, '--source-sequence', '5', '--sequence', '6')).toThrow(/computes the sequence/);
            expect(parse('stage', '--version', VERSION, '--sequence', '5', '--dry-run').options).toMatchObject({ sequence: 5, 'dry-run': true });
            expect(() => parse('stage', '--version', VERSION)).toThrow();
            expect(() => parse('stage', '--version', VERSION, '--sequence', '5', '--confirm-promote')).toThrow(/unknown option for stage/);
        });
    });

    describe('prepare', () => {
        test('computes the sequence from the live manifest in R2, carries the live launcher entry and records the base', async () => {
            await cli.prepare(config, { version: VERSION, 'skip-build': true });
            expect(bundle(5).payload.sequence).toBe(5);
            expect(bundle(5).payload.launcher).toEqual(LIVE_LAUNCHER);
            expect(bundle(5).payload.client.version).toBe(VERSION);
            expect(bundle(5).metadata.base).toEqual({ etag: memory.etag(BUCKET, MANIFEST), sequence: 4 });
            expect(output.join('')).toContain('Sequence: 5 (live sequence 4 + 1)');
            expect(puts()).toEqual([]);
            expect(cli.deps.openStore).toHaveBeenCalledWith(config, { writable: false });
        });

        test('reads R2, not the cached edge', async () => {
            cli.deps.liveManifest.mockImplementation(async () => { throw new Error('the edge must not be used'); });
            await cli.prepare(config, { version: VERSION, 'skip-build': true });
            expect(bundle(5).payload.sequence).toBe(5);
        });

        test('reads the live manifest after the build, so the base is current', async () => {
            cli.deps.runGradleBuild.mockImplementation(() => seedManifest({ sequence: 6 }));
            await cli.prepare(config, { version: VERSION });
            expect(bundle(7).payload.sequence).toBe(7);
            expect(bundle(7).metadata.base.sequence).toBe(6);
        });

        test('records no launcher when none is live', async () => {
            seedManifest({ sequence: 4, launcher: null });
            await cli.prepare(config, { version: VERSION, 'skip-build': true });
            expect(bundle(5).payload.launcher).toBeNull();
        });

        test('a channel without a manifest starts at sequence 1 and is based on "absent"', async () => {
            memory.delete(BUCKET, MANIFEST);
            await cli.prepare(config, { version: VERSION, 'skip-build': true });
            expect(bundle(1).metadata.base).toEqual({ etag: null, sequence: 0 });
            await cli.stage(config, options(1));
            await cli.promote(config, promoteOptions(1));
            expect(liveOf().sequence).toBe(1);
            expect(puts().pop()).toMatchObject({ op: 'putIfAbsent', key: MANIFEST });
        });

        test('a rollback computes its sequence too and carries the live launcher entry', async () => {
            await cli.prepare(config, { version: VERSION, 'skip-build': true });
            await cli.stage(config, options(5));
            await cli.promote(config, promoteOptions(5));
            await cli.prepareRollback(config, { version: VERSION, 'source-sequence': 5 });
            expect(bundle(6).payload.launcher).toEqual(LIVE_LAUNCHER);
            expect(bundle(6).metadata.base.sequence).toBe(5);
        });

        test('a preserved bundle without a base still works as a rollback source', async () => {
            await cli.prepare(config, { version: VERSION, 'skip-build': true });
            await cli.stage(config, options(5));
            await cli.promote(config, promoteOptions(5));
            const file = path.join(bundleDirectory(cli.deps.workRoot, 'staging', VERSION, 5), 'release.json');
            const { base, ...legacy } = JSON.parse(fs.readFileSync(file, 'utf8'));
            fs.writeFileSync(file, JSON.stringify(legacy));
            await cli.prepareRollback(config, { version: VERSION, 'source-sequence': 5 });
            expect(bundle(6).payload.client.sha256).toBe(bundle(5).payload.client.sha256);
            expect(bundle(6).metadata.base).toEqual({ etag: memory.etag(BUCKET, MANIFEST), sequence: 5 });
            await cli.stage(config, options(6));
            await cli.promote(config, promoteOptions(6));
            expect(liveOf().sequence).toBe(6);
        });

        test('a bundle prepared before bases were recorded is refused', async () => {
            await cli.prepare(config, { version: VERSION, 'skip-build': true });
            const file = path.join(bundleDirectory(cli.deps.workRoot, 'staging', VERSION, 5), 'release.json');
            const { base, ...legacy } = JSON.parse(fs.readFileSync(file, 'utf8'));
            fs.writeFileSync(file, JSON.stringify(legacy));
            await expect(cli.stage(config, options(5))).rejects.toThrow(/does not record the live manifest it was prepared against; prepare it again/);
            expect(puts()).toEqual([]);
        });
    });

    describe('stage', () => {
        beforeEach(async () => {
            await cli.prepare(config, { version: VERSION, 'skip-build': true });
        });

        test('writes the artifact and then the candidate, each only if absent, and verifies what the edge serves', async () => {
            await cli.stage(config, options(5));
            const written = puts();
            expect(written.map((entry) => entry.key)).toEqual([
                bundle(5).metadata.artifactObjectKey,
                'releases/staging/candidates/sequence-5-manifest.json'
            ]);
            expect(written.every((entry) => entry.condition.ifNoneMatch === true)).toBe(true);
            expect(liveOf().sequence).toBe(4);
            expect(output.join('')).toContain('the live channel was not changed');
        });

        test('refuses objects that already exist, and --resume only verifies them', async () => {
            await cli.stage(config, options(5));
            memory.log.length = 0;
            await expect(cli.stage(config, options(5))).rejects.toThrow(/immutable object already exists/);
            await cli.stage(config, options(5, { resume: true }));
            expect(puts()).toEqual([]);
            expect(output.join('')).toContain('verified existing artifact');
        });

        test('an artifact that differs is never overwritten', async () => {
            memory.seed(BUCKET, bundle(5).metadata.artifactObjectKey, Buffer.from('somebody else'));
            await expect(cli.stage(config, options(5, { resume: true }))).rejects.toThrow(/differs from the local bundle; it is never overwritten/);
            expect(puts()).toEqual([]);
        });

        test('a partial stage (artifact written, candidate failed) is finished by --resume without rewriting the artifact', async () => {
            memory.failNext('put', (key) => key.includes('/candidates/'), { message: 'network down' });
            await expect(cli.stage(config, options(5))).rejects.toThrow(/network down/);
            expect(memory.has(BUCKET, bundle(5).metadata.artifactObjectKey)).toBe(true);
            expect(memory.has(BUCKET, 'releases/staging/candidates/sequence-5-manifest.json')).toBe(false);
            memory.log.length = 0;
            await cli.stage(config, options(5, { resume: true }));
            expect(puts().map((entry) => entry.key)).toEqual(['releases/staging/candidates/sequence-5-manifest.json']);
        });

        test('a read-back that does not match after a successful write stops before the candidate', async () => {
            memory.corruptNext((key) => key.endsWith('.jar'));
            await expect(cli.stage(config, options(5))).rejects.toThrow(/read-back .* failed size or SHA-256/);
            expect(memory.has(BUCKET, 'releases/staging/candidates/sequence-5-manifest.json')).toBe(false);
        });

        test('an artifact that another publisher created in the meantime is verified, never replaced', async () => {
            const artifact = bundle(5).metadata.artifactObjectKey;
            memory.before = (op, bucket, key) => {
                if (op === 'putIfAbsent' && key === artifact) {
                    memory.before = null;
                    memory.seed(bucket, key, Buffer.from('client bytes'));
                }
            };
            // identical bytes created concurrently: without --resume it is refused, and it is not rewritten
            await expect(cli.stage(config, options(5))).rejects.toThrow(/was created by another publication while this one was staging/);
            expect(puts().filter((entry) => entry.key === artifact)).toHaveLength(1);
        });

        test('refuses a JAR above the single-request upload limit before any write', async () => {
            const limit = ops.MAX_SINGLE_PUT_BYTES;
            ops.MAX_SINGLE_PUT_BYTES = 5;
            try {
                await expect(cli.stage(config, options(5))).rejects.toThrow(/single-request upload limit/);
            } finally {
                ops.MAX_SINGLE_PUT_BYTES = limit;
            }
            expect(puts()).toEqual([]);
        });

        describe('an abandoned staged candidate does not block the channel', () => {
            test('the next prepare skips the sequence whose candidate is already in R2', async () => {
                await cli.stage(config, options(5));
                output.length = 0;
                await cli.prepare(config, { version: VERSION, 'skip-build': true });
                expect(bundle(6).payload.sequence).toBe(6);
                expect(bundle(6).metadata.base.sequence).toBe(4);
                expect(output.join('')).toContain('Sequence: 6 (live sequence 4 + 1, skipping 5: a candidate is already staged in R2)');
                await cli.stage(config, options(6, { resume: true }));
                await cli.promote(config, promoteOptions(6));
                expect(liveOf().sequence).toBe(6);
                expect(liveOf().client.version).toBe(VERSION);
            });

            test('a candidate whose read-back failed is left alone and the re-prepare goes around it', async () => {
                memory.corruptNext((key) => key.includes('/candidates/'));
                await expect(cli.stage(config, options(5))).rejects.toThrow(/read-back .* failed size or SHA-256/);
                await cli.prepare(config, { version: VERSION, 'skip-build': true });
                await cli.stage(config, options(6, { resume: true }));
                await cli.promote(config, promoteOptions(6));
                expect(liveOf().sequence).toBe(6);
            });
        });

        test('refuses, before any write, when the channel moved on after prepare', async () => {
            seedManifest({ sequence: 5, launcher: NEWER_LAUNCHER });
            const error = await cli.stage(config, options(5)).catch((failure) => failure);
            expect(error).toBeInstanceOf(ops.PublicationConflictError);
            expect(error.message).toMatch(/changed after this bundle was prepared.*launcher 3.2.12/s);
            expect(puts()).toEqual([]);
        });

        test('the older checks still explain it in release terms', async () => {
            seedManifest({ sequence: 4, launcher: null });
            rebase(5);
            await expect(cli.stage(config, options(5))).rejects.toThrow('live launcher entry');
            seedManifest({ sequence: 5 });
            rebase(5);
            await expect(cli.stage(config, options(5))).rejects.toThrow(/must be greater than live sequence 5/);
            expect(puts()).toEqual([]);
        });
    });

    describe('promote', () => {
        beforeEach(async () => {
            await cli.prepare(config, { version: VERSION, 'skip-build': true });
            await cli.stage(config, options(5));
            memory.log.length = 0;
        });

        test('replaces the manifest only if it is still the one the bundle was based on, and keeps the launcher entry', async () => {
            const base = memory.etag(BUCKET, MANIFEST);
            await cli.promote(config, promoteOptions(5));
            expect(puts()).toEqual([expect.objectContaining({ op: 'putIfMatch', key: MANIFEST, condition: { ifMatch: base } })]);
            expect(liveOf().sequence).toBe(5);
            expect(liveOf().client.version).toBe(VERSION);
            expect(liveOf().launcher).toEqual(LIVE_LAUNCHER);
            expect(output.join('')).toContain(`Promoted ${VERSION} sequence 5 to staging`);
        });

        test('needs an explicit confirmation', async () => {
            await expect(cli.promote(config, options(5))).rejects.toThrow(/--confirm-promote/);
            expect(puts()).toEqual([]);
        });

        test('a launcher release that lands after prepare is never dropped: the client promote refuses', async () => {
            seedManifest({ sequence: 5, launcher: NEWER_LAUNCHER });
            const error = await cli.promote(config, promoteOptions(5)).catch((failure) => failure);
            expect(error).toBeInstanceOf(ops.PublicationConflictError);
            expect(error.message).toMatch(/Prepare a new candidate/);
            expect(puts()).toEqual([]);
            expect(liveOf().launcher).toEqual(NEWER_LAUNCHER);
            expect(liveOf().client).toEqual(OLD_CLIENT);
        });

        test.each([[412], [409]])('a launcher release inside the write window (HTTP %i) is refused by R2 and kept', async (status) => {
            memory.conflictStatus = status;
            // after every client check passed, right before the write: a launcher promote goes live
            memory.before = (op, bucket, key) => {
                if (op === 'putIfMatch' && key === MANIFEST) {
                    memory.before = null;
                    seedManifest({ sequence: 5, launcher: NEWER_LAUNCHER });
                }
            };
            const error = await cli.promote(config, promoteOptions(5)).catch((failure) => failure);
            expect(error).toBeInstanceOf(ops.PublicationConflictError);
            expect(error.message).toMatch(/replaced while this promotion was running/);
            expect(error.message).toMatch(/launcher 3.2.12/);
            expect(liveOf().launcher).toEqual(NEWER_LAUNCHER);
            expect(liveOf().client).toEqual(OLD_CLIENT);
            expect(puts()).toHaveLength(1);
        });

        test('a second client release prepared while the first is staged goes around its candidate, and cannot outlive its promotion', async () => {
            // sequence 5 is taken by the staged p17 candidate, so p18 is prepared as sequence 6 from the same base
            await cli.prepare(config, { version: 'cut-2.6.30-p18', 'skip-build': true });
            const second = { version: 'cut-2.6.30-p18', sequence: 6 };
            await cli.promote(config, promoteOptions(5));
            memory.log.length = 0;
            await expect(cli.stage(config, second)).rejects.toThrow(/changed after this bundle was prepared/);
            await expect(cli.promote(config, { ...second, 'confirm-promote': true })).rejects.toThrow(/changed after this bundle was prepared/);
            expect(puts()).toEqual([]);
            expect(liveOf().client.version).toBe(VERSION);
        });

        test('two client releases prepared before either is staged compute the same sequence: only one can stage it', async () => {
            const publisher = async (version) => {
                await cli.prepare(config, { version, 'skip-build': true });
            };
            memory.delete(BUCKET, 'releases/staging/candidates/sequence-5-manifest.json');
            await publisher('cut-2.6.30-p18');
            await publisher('cut-2.6.30-p19');
            const third = { version: 'cut-2.6.30-p19', sequence: 5 };
            await cli.stage(config, { version: 'cut-2.6.30-p18', sequence: 5 });
            await expect(cli.stage(config, third)).rejects.toThrow(/differs from the local bundle; it is never overwritten/);
        });

        test('refuses when the artifact or the candidate is not staged, or is not the bundle', async () => {
            memory.delete(BUCKET, 'releases/staging/candidates/sequence-5-manifest.json');
            await expect(cli.promote(config, promoteOptions(5))).rejects.toThrow(/candidate manifest is not staged/);
            memory.delete(BUCKET, bundle(5).metadata.artifactObjectKey);
            await expect(cli.promote(config, promoteOptions(5))).rejects.toThrow(/staged artifact is unavailable or has the wrong size/);
            expect(puts()).toEqual([]);
        });

        test('refuses a candidate that is not the signed manifest of this bundle', async () => {
            const other = signReleaseManifest(
                { schemaVersion: 1, channel: 'staging', sequence: 5, publishedAt: '2026-10-12T00:00:00Z', launcher: LIVE_LAUNCHER, client: bundle(5).payload.client },
                { keyId: config.keyId, privateKeyPem: keys.privateKeyPem }
            );
            memory.seed(BUCKET, 'releases/staging/candidates/sequence-5-manifest.json', Buffer.from(JSON.stringify(other)));
            await expect(cli.promote(config, promoteOptions(5))).rejects.toThrow(/staged candidate does not match/);
            expect(puts()).toEqual([]);
        });

        test('cannot be promoted twice', async () => {
            await cli.promote(config, promoteOptions(5));
            memory.log.length = 0;
            await expect(cli.promote(config, promoteOptions(5))).rejects.toThrow(/changed after this bundle was prepared/);
            expect(puts()).toEqual([]);
        });

        describe('a manifest write whose answer is lost', () => {
            test('not applied: nothing was written and the same promote may be run again', async () => {
                memory.failNext('put', (key) => key === MANIFEST, { message: 'socket hang up' });
                await expect(cli.promote(config, promoteOptions(5))).rejects.toThrow(/live manifest is unchanged: nothing was written/);
                expect(liveOf().sequence).toBe(4);
                await cli.promote(config, promoteOptions(5));
                expect(liveOf().sequence).toBe(5);
            });

            test('applied: the live manifest is the candidate, so the promotion is recognised as done', async () => {
                memory.failNext('put', (key) => key === MANIFEST, { apply: true, message: 'socket hang up' });
                await cli.promote(config, promoteOptions(5));
                expect(liveOf().client.version).toBe(VERSION);
                expect(output.join('')).toContain(`Promoted ${VERSION} sequence 5`);
            });
        });

        test('reports a public edge that does not serve the new manifest', async () => {
            cli.deps.liveManifest.mockImplementation(async () => ({ ...liveOf(), sequence: 4 }));
            await expect(cli.promote(config, promoteOptions(5))).rejects.toThrow(/public manifest does not match.*live in R2/s);
            expect(liveOf().sequence).toBe(5);
        });
    });

    describe('dry run', () => {
        beforeEach(async () => {
            await cli.prepare(config, { version: VERSION, 'skip-build': true });
        });

        test('stage and promote read only, through stores that cannot write', async () => {
            await cli.stage(config, options(5));
            memory.log.length = 0;
            cli.deps.openStore.mockClear();
            await cli.stage(config, options(5, { 'dry-run': true, resume: true }));
            await cli.promote(config, options(5, { 'dry-run': true }));
            expect(puts()).toEqual([]);
            for (const [, opts] of cli.deps.openStore.mock.calls) expect(opts).toEqual({ writable: false });
            expect(output.join('')).toContain('passed every check');
            expect(liveOf().sequence).toBe(4);
        });

        test('stage reports what it would upload', async () => {
            await cli.stage(config, options(5, { 'dry-run': true }));
            expect(output.join('')).toContain('would upload artifact');
            expect(puts()).toEqual([]);
        });

        test('through the real S3 transport no PUT request leaves the process', async () => {
            const fetchMock = createMemoryFetch(memory);
            cli.deps.openStore.mockImplementation((cfg, opts) => createR2Store({
                bucket: cfg.bucket, accountId: 'acct', accessKeyId: 'AK', secretAccessKey: 'SK', fetch: fetchMock, ...opts
            }));
            await cli.stage(config, options(5, { 'dry-run': true }));
            await cli.stage(config, options(5));
            fetchMock.requests.length = 0;
            await cli.promote(config, options(5, { 'dry-run': true }));
            expect(fetchMock.requests.length).toBeGreaterThan(0);
            expect(fetchMock.requests.every((request) => ['GET', 'HEAD'].includes(request.method))).toBe(true);
        });
    });

    test('through the real S3 transport the manifest write carries If-Match with the base ETag', async () => {
        await cli.prepare(config, { version: VERSION, 'skip-build': true });
        const base = memory.etag(BUCKET, MANIFEST);
        const fetchMock = createMemoryFetch(memory);
        cli.deps.openStore.mockImplementation((cfg, opts) => createR2Store({
            bucket: cfg.bucket, accountId: 'acct', accessKeyId: 'AK', secretAccessKey: 'SK', fetch: fetchMock, ...opts
        }));
        await cli.stage(config, options(5));
        await cli.promote(config, promoteOptions(5));
        const writes = fetchMock.requests.filter((request) => request.method === 'PUT');
        expect(writes.map((request) => request.key)).toEqual([bundle(5).metadata.artifactObjectKey, 'releases/staging/candidates/sequence-5-manifest.json', MANIFEST]);
        expect(writes.slice(0, 2).every((request) => request.headers['if-none-match'] === '*')).toBe(true);
        expect(writes[2].headers['if-match']).toBe(base);
    });
});
