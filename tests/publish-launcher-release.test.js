const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cli = require('../scripts/publish-launcher-release');
const io = require('../libs/release-publication-io');
const ops = require('../libs/release-store-ops');
const { createR2Store } = require('../libs/r2-store');
const { createMemoryFetch, createMemoryR2 } = require('./helpers/memory-r2');
const launcherRelease = require('../libs/launcher-release-publication');
const { verifyReleaseManifest } = require('../libs/release-manifest');
const { signReleaseManifest } = require('../libs/release-manifest-signing');

// The CLI is exercised against an in-memory R2 (with real ETag and conditional-write semantics) and a
// fake edge. Nothing here reaches the network or a real bucket.

const VERSION = '3.2.11';
const FILE_NAME = `Microbot-Cut-Launcher-Setup-${VERSION}.exe`;
const COMMIT = 'a'.repeat(40);
const OLD_CLIENT = Object.freeze({
    version: 'cut-2.6.30-p16',
    minimumLauncherVersion: '3.2.10',
    artifactPath: 'releases/artifacts/client/cut-2.6.30-p16/microbot-cut-2.6.30-p16.jar',
    size: 10,
    sha256: 'd'.repeat(64)
});
const KEYS = launcherRelease.launcherObjectKeys(VERSION);

function candidateFor(profile, bytes) {
    return {
        kind: 'launcher-candidate',
        unsigned: true,
        profile,
        version: VERSION,
        file: FILE_NAME,
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        sha512Base64: crypto.createHash('sha512').update(bytes).digest('base64'),
        sourceCommit: COMMIT,
        sourceDirty: false,
        effectiveConfiguration: {
            environment: profile,
            releaseChannel: profile,
            environmentVariableOverrides: false,
            launcherUpdateFeed: null
        },
        embeddedProfileSha256: crypto.createHash('sha256').update(`profile-${profile}`).digest('hex'),
        appAsarSha256: crypto.createHash('sha256').update(`asar-${profile}`).digest('hex')
    };
}

describe('launcher publication CLI', () => {
    let directory;
    let channels;
    let candidates;
    let world;
    let original;
    let output;

    let memory;
    const bucketKey = (name, key) => `${channels[name].config.bucket}/${key}`;
    const splitFull = (full) => {
        const slash = full.indexOf('/');
        return [full.slice(0, slash), full.slice(slash + 1)];
    };
    const manifestKey = (name) => bucketKey(name, `releases/${name}/manifest.json`);
    const candidateKey = (name, sequence) => bucketKey(name, `releases/${name}/candidates/sequence-${sequence}-manifest.json`);
    const config = (name) => channels[name].config;

    function makeChannel(name) {
        const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const keyId = `release-${name}-test`;
        const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
        const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
        fs.mkdirSync(path.join(directory, 'config'), { recursive: true });
        const base = path.join(directory, 'config');
        fs.writeFileSync(path.join(base, `${name}.pem`), privateKeyPem);
        fs.writeFileSync(path.join(base, `${name}.public.json`), JSON.stringify({ keyId, publicKey }));
        const configPath = path.join(base, `release-publication.${name}.json`);
        fs.writeFileSync(configPath, JSON.stringify({
            channel: name,
            bucket: `bucket-${name}`,
            publicBaseUrl: `https://cut-${name}.example/api/v1/`,
            manifestUrl: `https://cut-${name}.example/api/v1/releases/${name}/manifest`,
            keyId,
            privateKeyFile: `${name}.pem`,
            publicKeyFile: `${name}.public.json`,
            minimumLauncherVersion: '3.2.10',
            clientRepository: '../client',
            backendRepository: '../backend',
            gradleUserHome: '../gradle',
            sourceJar: '../source.jar'
        }));
        return { keyId, publicKey, privateKeyPem, configPath, config: io.loadConfiguration(configPath) };
    }

    function seedManifest(name, { sequence, launcher = null, client = OLD_CLIENT }) {
        const channel = channels[name];
        const payload = {
            schemaVersion: 1,
            channel: name,
            sequence,
            publishedAt: '2026-10-10T00:00:00.000Z',
            launcher,
            client
        };
        const envelope = signReleaseManifest(payload, { keyId: channel.keyId, privateKeyPem: channel.privateKeyPem });
        world.r2.set(manifestKey(name), Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`));
    }

    // Points a bundle at the live manifest as it is now. Used to reach the checks that sit behind the
    // base-ETag check (sequence, entries) when the manifest was changed after the bundle was prepared.
    function rebase(name, options, kind = 'launcher') {
        const directory = kind === 'withdrawal'
            ? launcherRelease.launcherWithdrawalDirectory(cli.deps.workRoot, name, options.sequence)
            : launcherRelease.launcherBundleDirectory(cli.deps.workRoot, name, options.version, options.sequence);
        const file = path.join(directory, 'release.json');
        const release = JSON.parse(fs.readFileSync(file, 'utf8'));
        const live = liveOf(name);
        fs.writeFileSync(file, JSON.stringify({ ...release, base: { etag: memory.etag(config(name).bucket, `releases/${name}/manifest.json`), sequence: live.sequence } }));
    }

    function liveOf(name) {
        const bytes = world.r2.get(manifestKey(name));
        if (!bytes) return null;
        return verifyReleaseManifest(JSON.parse(bytes.toString('utf8')), {
            expectedChannel: name,
            trustedKeys: { [channels[name].keyId]: channels[name].publicKey }
        });
    }

    function makeCandidate(profile) {
        const dir = path.join(directory, 'candidates', profile);
        fs.mkdirSync(dir, { recursive: true });
        const bytes = crypto.randomBytes(2048);
        fs.writeFileSync(path.join(dir, FILE_NAME), bytes);
        const record = candidateFor(profile, bytes);
        fs.writeFileSync(path.join(dir, 'candidate.json'), JSON.stringify(record));
        return { dir, ...record };
    }

    const candidateDir = (name) => candidates[name].dir;

    const prepareOptions = (name, extra = {}) => ({
        version: VERSION,
        candidate: candidateDir(name),
        'validated-sha256': candidates[name].sha256,
        ...(name === 'production'
            ? { 'staging-candidate': candidateDir('staging'), 'staging-config': channels.staging.configPath }
            : {}),
        ...extra
    });
    const releaseOptions = (name, extra = {}) => ({
        version: VERSION,
        sequence: name === 'staging' ? 5 : 3,
        'staging-config': channels.staging.configPath,
        ...extra
    });
    const promoteOptions = (name, extra = {}) => releaseOptions(name, { 'confirm-promote': true, ...extra });

    const readBundle = (name, options) => launcherRelease.readAndVerifyLauncherBundle({
        outputDirectory: launcherRelease.launcherBundleDirectory(cli.deps.workRoot, name, VERSION, options.sequence),
        channel: name,
        keyId: channels[name].keyId,
        publicKey: channels[name].publicKey
    });

    async function publishOnStaging() {
        await cli.prepare(config('staging'), prepareOptions('staging'));
        await cli.stage(config('staging'), releaseOptions('staging'));
        await cli.promote(config('staging'), promoteOptions('staging'));
    }

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-launcher-cli-'));
        fs.mkdirSync(path.join(directory, 'backend', 'node_modules', 'wrangler', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'backend', 'node_modules', 'wrangler', 'bin', 'wrangler.js'), '');
        channels = { staging: makeChannel('staging'), production: makeChannel('production') };
        candidates = { staging: makeCandidate('staging'), production: makeCandidate('production') };
        memory = createMemoryR2();
        world = {
            // a Map-like view of the memory bucket, keyed by `bucket/key`
            r2: {
                get: (full) => memory.bytes(...splitFull(full)),
                set: (full, bytes) => memory.seed(...splitFull(full), bytes),
                has: (full) => memory.has(...splitFull(full)),
                delete: (full) => memory.delete(...splitFull(full))
            },
            writes: [],
            gets: [],
            edgeFrozen: null,
            site: {
                download: { status: 401, code: 'unauthorized' },
                closed: { status: 404, code: 'release_not_found' },
                publicInstaller: 404
            }
        };
        // `writes` lists the writes R2 applied; `gets` the reads.
        memory.after = (op, bucket, key) => world.writes.push(`${bucket}/${key}`);
        seedManifest('staging', { sequence: 4 });
        seedManifest('production', { sequence: 2 });

        original = { ...cli.deps };
        const respond = ({ status, code }) => new Response(
            code ? JSON.stringify({ error: { code } }) : null,
            { status, headers: { 'Content-Type': 'application/json' } }
        );
        Object.assign(cli.deps, {
            workRoot: path.join(directory, 'work'),
            liveManifest: jest.fn(async (cfg, { allowMissing = false } = {}) => {
                const live = liveOf(cfg.channel);
                if (!live) {
                    if (allowMissing) return null;
                    throw new Error('live manifest returned HTTP 404');
                }
                return world.edgeFrozen && world.edgeFrozen.channel === cfg.channel ? world.edgeFrozen : live;
            }),
            fetchResponse: jest.fn(async (url) => {
                const { pathname } = new URL(url);
                if (pathname.endsWith('/downloads/launcher')) return respond(world.site.download);
                if (pathname.includes('/releases/artifacts/launcher/0.0.0/')) return respond(world.site.closed);
                if (pathname.includes('/releases/artifacts/launcher/')) return respond({ status: world.site.publicInstaller });
                throw new Error(`unexpected request: ${url}`);
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

    describe('argument parsing', () => {
        const parse = (...argv) => cli.parseArguments(argv);

        test('accepts the documented commands', () => {
            expect(parse('prepare', '--version', VERSION, '--candidate', 'x', '--validated-sha256', 'a'.repeat(64)).options.sequence).toBeUndefined();
            expect(parse('stage', '--version', VERSION, '--sequence', '5', '--resume', '--dry-run').options).toMatchObject({ resume: true, 'dry-run': true });
            expect(parse('promote', '--withdrawal', '--sequence', '7', '--confirm-promote').options.withdrawal).toBe(true);
            expect(parse('prepare-withdraw').options).toEqual({});
            expect(parse('prepare-rollback', '--version', VERSION, '--source-sequence', '5').options['source-sequence']).toBe(5);
        });

        test.each([
            ['an unknown command', ['publish']],
            ['an unknown option', ['stage', '--version', VERSION, '--sequence', '5', '--dry-runn']],
            ['an option of another command', ['stage', '--version', VERSION, '--sequence', '5', '--candidate', 'x']],
            ['a missing value', ['stage', '--version', VERSION, '--sequence']],
            ['a bad sequence', ['stage', '--version', VERSION, '--sequence', '0']],
            ['a bad version', ['stage', '--version', '3.2', '--sequence', '5']],
            ['no version', ['stage', '--sequence', '5']],
            ['a withdrawal with a version', ['stage', '--withdrawal', '--version', VERSION, '--sequence', '5']],
            ['a prepare without the validated hash', ['prepare', '--version', VERSION, '--candidate', 'x']],
            ['a malformed validated hash', ['prepare', '--version', VERSION, '--candidate', 'x', '--validated-sha256', 'ABC']],
            ['a typed sequence on prepare', ['prepare', '--version', VERSION, '--sequence', '5', '--candidate', 'x', '--validated-sha256', 'a'.repeat(64)]],
            ['a typed sequence on prepare-rollback', ['prepare-rollback', '--version', VERSION, '--source-sequence', '5', '--sequence', '6']],
            ['a typed sequence on prepare-withdraw', ['prepare-withdraw', '--sequence', '8']],
            ['a stray argument', ['stage', 'extra']]
        ])('refuses %s', (_label, argv) => {
            expect(() => cli.parseArguments(argv)).toThrow();
        });
    });

    describe('prepare', () => {
        test('prepares a signed staging bundle that carries the live client entry', async () => {
            await cli.prepare(config('staging'), prepareOptions('staging'));
            const bundle = readBundle('staging', { sequence: 5 });
            expect(bundle.payload.launcher.version).toBe(VERSION);
            expect(bundle.payload.client).toEqual(OLD_CLIENT);
            expect(bundle.metadata.validatedSha256).toBe(candidates.staging.sha256);
            expect(world.writes).toEqual([]);
            expect(output.join('')).toContain('Minimum supported launcher: 3.2.10');
        });

        test('computes the sequence from the live manifest in R2 and records what the bundle is based on', async () => {
            await cli.prepare(config('staging'), prepareOptions('staging'));
            const bundle = readBundle('staging', { sequence: 5 });
            expect(bundle.payload.sequence).toBe(5);
            expect(bundle.metadata.base).toEqual({ etag: memory.etag('bucket-staging', 'releases/staging/manifest.json'), sequence: 4 });
            expect(output.join('')).toContain('Sequence: 5 (live sequence 4 + 1)');
            expect(output.join('')).toContain(`Based on live ETag: ${bundle.metadata.base.etag}`);
        });

        test('reads R2, not the cached edge, and never writes', async () => {
            cli.deps.liveManifest.mockImplementation(async () => { throw new Error('the edge must not be used'); });
            await cli.prepare(config('staging'), prepareOptions('staging'));
            expect(memory.log.some((entry) => entry.op === 'get' && entry.key === 'releases/staging/manifest.json')).toBe(true);
            expect(memory.log.filter((entry) => entry.op.startsWith('put'))).toEqual([]);
            expect(cli.deps.openStore).toHaveBeenCalledWith(expect.anything(), { writable: false });
        });

        test('a sequence typed by hand is not possible and prepare picks the next one when the channel moved', async () => {
            seedManifest('staging', { sequence: 7 });
            await cli.prepare(config('staging'), prepareOptions('staging'));
            expect(readBundle('staging', { sequence: 8 }).payload.sequence).toBe(8);
        });

        test('reports where the minimum supported version came from', async () => {
            await cli.prepare(config('staging'), prepareOptions('staging', { 'minimum-supported': '3.2.11' }));
            expect(readBundle('staging', { sequence: 5 }).payload.launcher.minimumSupportedVersion).toBe('3.2.11');
            expect(output.join('')).toContain('(from --minimum-supported)');

            output.length = 0;
            fs.rmSync(launcherRelease.launcherBundleDirectory(cli.deps.workRoot, 'staging', VERSION, 5), { recursive: true });
            await cli.prepare({ ...config('staging'), minimumSupportedLauncherVersion: '3.2.10' }, prepareOptions('staging'));
            expect(output.join('')).toContain('minimumSupportedLauncherVersion in the configuration');
        });

        test('only the validated bytes can be prepared', async () => {
            await expect(cli.prepare(config('staging'), prepareOptions('staging', { 'validated-sha256': 'c'.repeat(64) })))
                .rejects.toThrow(/not the one that was validated/);
            expect(fs.existsSync(path.join(cli.deps.workRoot, 'staging'))).toBe(false);
        });

        test('needs a live manifest and a newer launcher', async () => {
            seedManifest('staging', { sequence: 4, launcher: { ...liveLauncher(VERSION) } });
            await expect(cli.prepare(config('staging'), prepareOptions('staging'))).rejects.toThrow(/must be newer/);
            world.r2.delete(manifestKey('staging'));
            await expect(cli.prepare(config('staging'), prepareOptions('staging'))).rejects.toThrow(/no live manifest/);
        });

        test('production needs the staging candidate and the same release live on staging', async () => {
            await expect(cli.prepare(config('production'), prepareOptions('production', { 'staging-candidate': undefined })))
                .rejects.toThrow(/--staging-candidate/);
            await expect(cli.prepare(config('production'), prepareOptions('production')))
                .rejects.toThrow(/publish and validate it on staging first/);
            await publishOnStaging();
            await cli.prepare(config('production'), prepareOptions('production'));
            const bundle = readBundle('production', { sequence: 3 });
            expect(bundle.metadata.profile).toBe('production');
            expect(bundle.metadata.sourceCommit).toBe(COMMIT);
            expect(bundle.metadata.stagingCandidate.sha256).toBe(candidates.staging.sha256);
            expect(bundle.metadata.sha256).not.toBe(candidates.staging.sha256);
        });

        test('production refuses a staging candidate that is not the one published on staging', async () => {
            await publishOnStaging();
            const other = path.join(directory, 'candidates', 'staging-other');
            fs.mkdirSync(other);
            const bytes = crypto.randomBytes(2048);
            fs.writeFileSync(path.join(other, FILE_NAME), bytes);
            fs.writeFileSync(path.join(other, 'candidate.json'), JSON.stringify(candidateFor('staging', bytes)));
            await expect(cli.prepare(config('production'), prepareOptions('production', { 'staging-candidate': other })))
                .rejects.toThrow(/staging first/);
        });

        test('a candidate for the other environment cannot be prepared', async () => {
            await expect(cli.prepare(config('staging'), prepareOptions('staging', {
                candidate: candidateDir('production'),
                'validated-sha256': candidates.production.sha256
            }))).rejects.toThrow(/built for production, not staging/);
        });

        function liveLauncher(version) {
            const keys = launcherRelease.launcherObjectKeys(version);
            return {
                version,
                minimumSupportedVersion: '3.2.10',
                platforms: { 'windows-x64': { artifactPath: keys.installer, updaterMetadataPath: keys.updater, size: 100, sha256: 'e'.repeat(64) } }
            };
        }
    });

    describe('stage', () => {
        beforeEach(async () => {
            await cli.prepare(config('staging'), prepareOptions('staging'));
        });

        test('uploads the installer, latest.yml and the candidate manifest in that order, and reads each back', async () => {
            const before = world.r2.get(manifestKey('staging'));
            await cli.stage(config('staging'), releaseOptions('staging'));
            expect(world.writes).toEqual([
                bucketKey('staging', KEYS.installer),
                bucketKey('staging', KEYS.updater),
                candidateKey('staging', 5)
            ]);
            const bundle = readBundle('staging', { sequence: 5 });
            expect(world.r2.get(bucketKey('staging', KEYS.installer)).equals(fs.readFileSync(bundle.artifactFile))).toBe(true);
            expect(world.r2.get(bucketKey('staging', KEYS.updater)).toString('utf8')).toBe(fs.readFileSync(bundle.updaterFile, 'utf8'));
            // every uploaded object was read back, after it was written and from R2 itself
            for (const key of world.writes) {
                const [bucket, objectKey] = splitFull(key);
                const written = memory.log.findIndex((entry) => entry.op === 'putIfAbsent' && entry.key === objectKey);
                expect(memory.log.slice(written + 1).some((entry) => entry.op === 'get' && entry.key === objectKey)).toBe(true);
                expect(bucket).toBe('bucket-staging');
            }
            // and every write was conditional on the object not existing
            expect(memory.log.filter((entry) => entry.op.startsWith('put')).every((entry) => entry.condition.ifNoneMatch === true)).toBe(true);
            expect(world.r2.get(manifestKey('staging')).equals(before)).toBe(true);
            expect(output.join('')).toContain('the live channel was not changed');
        });

        test('refuses objects that already exist and writes nothing', async () => {
            await cli.stage(config('staging'), releaseOptions('staging'));
            world.writes.length = 0;
            await expect(cli.stage(config('staging'), releaseOptions('staging'))).rejects.toThrow(/immutable object already exists/);
            expect(world.writes).toEqual([]);
        });

        test('--resume verifies what exists and never writes it again', async () => {
            await cli.stage(config('staging'), releaseOptions('staging'));
            world.writes.length = 0;
            await cli.stage(config('staging'), releaseOptions('staging', { resume: true }));
            expect(world.writes).toEqual([]);
            expect(output.join('')).toContain('verified existing installer');
        });

        test('a failed upload is finished with --resume without touching what was already uploaded', async () => {
            memory.failNext('put', (key) => key.endsWith('latest.yml'), { message: 'network down' });
            await expect(cli.stage(config('staging'), releaseOptions('staging'))).rejects.toThrow(/network down/);
            expect(world.writes).toEqual([bucketKey('staging', KEYS.installer)]);
            expect(world.r2.has(candidateKey('staging', 5))).toBe(false);

            await expect(cli.stage(config('staging'), releaseOptions('staging'))).rejects.toThrow(/already exists/);
            await cli.stage(config('staging'), releaseOptions('staging', { resume: true }));
            expect(world.writes).toEqual([
                bucketKey('staging', KEYS.installer),
                bucketKey('staging', KEYS.updater),
                candidateKey('staging', 5)
            ]);
        });

        test('an object that differs is never overwritten, even with --resume', async () => {
            world.r2.set(bucketKey('staging', KEYS.installer), Buffer.from('somebody else'));
            await expect(cli.stage(config('staging'), releaseOptions('staging', { resume: true })))
                .rejects.toThrow(/differs from the local bundle; it is never overwritten/);
            expect(world.writes).toEqual([]);
        });

        test('a corrupted read-back stops the release before the next object and the manifest', async () => {
            memory.corruptNext((key) => key.endsWith('.exe'));
            await expect(cli.stage(config('staging'), releaseOptions('staging'))).rejects.toThrow(/read-back .* failed size or SHA-256/);
            expect(world.writes).toEqual([bucketKey('staging', KEYS.installer)]);
            expect(liveOf('staging').sequence).toBe(4);
            await expect(cli.stage(config('staging'), releaseOptions('staging', { resume: true }))).rejects.toThrow(/never overwritten/);
        });

        test('only writes the keys of its own release', async () => {
            const file = path.join(cli.deps.workRoot, 'staging', 'sequence-5-launcher-3.2.11', 'release.json');
            const release = JSON.parse(fs.readFileSync(file, 'utf8'));
            fs.writeFileSync(file, JSON.stringify({ ...release, candidateObjectKey: 'releases/production/manifest.json' }));
            await expect(cli.stage(config('staging'), releaseOptions('staging'))).rejects.toThrow(/object keys do not match/);
            expect(world.writes).toEqual([]);
        });

        test('refuses a key outside the release even if the metadata lied, before the first upload', async () => {
            const real = launcherRelease.readAndVerifyLauncherBundle;
            jest.spyOn(launcherRelease, 'readAndVerifyLauncherBundle').mockImplementation((args) => {
                const bundle = real(args);
                return { ...bundle, metadata: { ...bundle.metadata, candidateObjectKey: 'releases/production/manifest.json' } };
            });
            await expect(cli.stage(config('staging'), releaseOptions('staging'))).rejects.toThrow(/outside the release/);
            expect(world.writes).toEqual([]);
        });

        test('refuses an installer above the single-request upload limit before any write', async () => {
            const file = path.join(cli.deps.workRoot, 'staging', 'sequence-5-launcher-3.2.11', 'release.json');
            const release = JSON.parse(fs.readFileSync(file, 'utf8'));
            fs.writeFileSync(file, JSON.stringify({ ...release, size: ops.MAX_SINGLE_PUT_BYTES + 1 }));
            await expect(cli.stage(config('staging'), releaseOptions('staging'))).rejects.toThrow(/single-request upload limit/);
            expect(world.writes).toEqual([]);
        });

        test('refuses when anything was published after the bundle was prepared, before any write', async () => {
            seedManifest('staging', { sequence: 4, client: { ...OLD_CLIENT, size: 11 } });
            const error = await cli.stage(config('staging'), releaseOptions('staging')).catch((failure) => failure);
            expect(error).toBeInstanceOf(ops.PublicationConflictError);
            expect(error.message).toMatch(/changed after this bundle was prepared.*Prepare a new candidate/s);
            expect(world.writes).toEqual([]);
        });

        test('refuses when the live sequence moved on', async () => {
            seedManifest('staging', { sequence: 5 });
            rebase('staging', releaseOptions('staging'));
            await expect(cli.stage(config('staging'), releaseOptions('staging'))).rejects.toThrow(/must be greater than live sequence 5/);
            expect(world.writes).toEqual([]);
        });

        test('refuses when the live client changed after the bundle was prepared', async () => {
            seedManifest('staging', { sequence: 4, client: { ...OLD_CLIENT, version: 'cut-2.6.31', sha256: 'f'.repeat(64) } });
            rebase('staging', releaseOptions('staging'));
            await expect(cli.stage(config('staging'), releaseOptions('staging'))).rejects.toThrow(/live client entry/);
            expect(world.writes).toEqual([]);
        });

        test('refuses a launcher that is not newer than the live one', async () => {
            seedManifest('staging', { sequence: 4, launcher: launcherEntryOf('3.2.12') });
            rebase('staging', releaseOptions('staging'));
            await expect(cli.stage(config('staging'), releaseOptions('staging'))).rejects.toThrow(/must be newer than the live launcher 3.2.12/);
            expect(world.writes).toEqual([]);
        });

        test.each([
            ['an older Worker without the download routes', { download: { status: 404, code: 'release_not_found' } }, /does not have the authenticated launcher download routes/],
            ['a download route that is not protected', { download: { status: 200, code: null } }, /does not have the authenticated launcher download routes/],
            ['a different error on the download route', { download: { status: 401, code: 'something_else' } }, /does not have the authenticated launcher download routes/],
            ['a public artifact route that serves launcher objects', { closed: { status: 200, code: null } }, /could become public/],
            ['a public artifact route with another error', { closed: { status: 404, code: 'artifact_missing' } }, /could become public/]
        ])('refuses %s before any write', async (_label, site, pattern) => {
            Object.assign(world.site, site);
            await expect(cli.stage(config('staging'), releaseOptions('staging'))).rejects.toThrow(pattern);
            expect(world.writes).toEqual([]);
        });

        test('fails closed when the site cannot be reached', async () => {
            cli.deps.fetchResponse.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
            await expect(cli.stage(config('staging'), releaseOptions('staging'))).rejects.toThrow(/could not check the launcher download routes/);
            expect(world.writes).toEqual([]);
        });

        test('production is staged only while the release is live on staging', async () => {
            await cli.stage(config('staging'), releaseOptions('staging'));
            await cli.promote(config('staging'), promoteOptions('staging'));
            await cli.prepare(config('production'), prepareOptions('production'));
            // staging moved on and no longer lists this release
            seedManifest('staging', { sequence: 6 });
            await expect(cli.stage(config('production'), releaseOptions('production'))).rejects.toThrow(/publish and validate it on staging first/);
            expect(world.writes.filter((full) => full.startsWith('bucket-production/'))).toEqual([]);
        });

        function launcherEntryOf(version) {
            const keys = launcherRelease.launcherObjectKeys(version);
            return {
                version,
                minimumSupportedVersion: '3.2.10',
                platforms: { 'windows-x64': { artifactPath: keys.installer, updaterMetadataPath: keys.updater, size: 100, sha256: 'e'.repeat(64) } }
            };
        }
    });

    describe('promote', () => {
        beforeEach(async () => {
            await cli.prepare(config('staging'), prepareOptions('staging'));
            await cli.stage(config('staging'), releaseOptions('staging'));
            world.writes.length = 0;
        });

        test('needs an explicit confirmation', async () => {
            await expect(cli.promote(config('staging'), releaseOptions('staging'))).rejects.toThrow(/--confirm-promote/);
            expect(world.writes).toEqual([]);
        });

        test('writes the signed manifest last, from the staged bytes, and verifies it', async () => {
            const clientBefore = liveOf('staging').client;
            await cli.promote(config('staging'), promoteOptions('staging'));
            expect(world.writes).toEqual([manifestKey('staging')]);
            expect(world.r2.get(manifestKey('staging')).equals(world.r2.get(candidateKey('staging', 5)))).toBe(true);
            const live = liveOf('staging');
            expect(live.sequence).toBe(5);
            expect(live.launcher.version).toBe(VERSION);
            expect(live.client).toEqual(clientBefore);
            expect(output.join('')).toContain('Promoted launcher 3.2.11 sequence 5 to staging');
        });

        test('refuses when the installer was never staged or is not the bundle bytes', async () => {
            world.r2.delete(bucketKey('staging', KEYS.installer));
            await expect(cli.promote(config('staging'), promoteOptions('staging'))).rejects.toThrow(/installer is not staged/);
            world.r2.set(bucketKey('staging', KEYS.installer), Buffer.from('tampered'));
            await expect(cli.promote(config('staging'), promoteOptions('staging'))).rejects.toThrow(/staged installer does not match/);
            expect(world.writes).toEqual([]);
        });

        test('refuses when latest.yml or the candidate is missing or different', async () => {
            const updater = world.r2.get(bucketKey('staging', KEYS.updater));
            world.r2.set(bucketKey('staging', KEYS.updater), Buffer.from(`${updater}\n# edited`));
            await expect(cli.promote(config('staging'), promoteOptions('staging'))).rejects.toThrow(/staged latest.yml does not match/);
            world.r2.set(bucketKey('staging', KEYS.updater), updater);
            world.r2.delete(candidateKey('staging', 5));
            await expect(cli.promote(config('staging'), promoteOptions('staging'))).rejects.toThrow(/candidate manifest is not staged/);
            expect(world.writes).toEqual([]);
        });

        test('refuses a candidate that is not the signed manifest of this bundle', async () => {
            const other = path.join(directory, 'other.json');
            fs.writeFileSync(other, JSON.stringify(signReleaseManifest(
                { schemaVersion: 1, channel: 'staging', sequence: 5, publishedAt: '2026-10-12T00:00:00.000Z', launcher: null, client: OLD_CLIENT },
                { keyId: channels.staging.keyId, privateKeyPem: channels.staging.privateKeyPem }
            )));
            world.r2.set(candidateKey('staging', 5), fs.readFileSync(other));
            await expect(cli.promote(config('staging'), promoteOptions('staging'))).rejects.toThrow(/staged candidate does not match/);
            expect(world.writes).toEqual([]);
        });

        test('refuses on a Worker without the launcher routes, so the installer cannot become public', async () => {
            world.site.download = { status: 404, code: 'release_not_found' };
            await expect(cli.promote(config('staging'), promoteOptions('staging'))).rejects.toThrow(/does not have the authenticated launcher download routes/);
            expect(world.writes).toEqual([]);
        });

        test('refuses a manifest key outside the release even if the metadata lied', async () => {
            const real = launcherRelease.readAndVerifyLauncherBundle;
            jest.spyOn(launcherRelease, 'readAndVerifyLauncherBundle').mockImplementation((args) => {
                const bundle = real(args);
                return { ...bundle, metadata: { ...bundle.metadata, manifestObjectKey: 'releases/production/manifest.json' } };
            });
            await expect(cli.promote(config('staging'), promoteOptions('staging'))).rejects.toThrow(/outside the release/);
            expect(world.writes).toEqual([]);
        });

        test('refuses when somebody published a higher sequence first', async () => {
            seedManifest('staging', { sequence: 5 });
            rebase('staging', releaseOptions('staging'));
            await expect(cli.promote(config('staging'), promoteOptions('staging'))).rejects.toThrow(/must be greater than live sequence 5/);
            expect(world.writes).toEqual([]);
        });

        test('refuses when the live client changed after staging', async () => {
            seedManifest('staging', { sequence: 4, client: { ...OLD_CLIENT, version: 'cut-2.6.31', sha256: 'f'.repeat(64) } });
            rebase('staging', releaseOptions('staging'));
            await expect(cli.promote(config('staging'), promoteOptions('staging'))).rejects.toThrow(/live client entry/);
            expect(world.writes).toEqual([]);
        });

        test('writes the manifest only if it is still the one the bundle was based on (If-Match)', async () => {
            const base = memory.etag('bucket-staging', 'releases/staging/manifest.json');
            memory.log.length = 0;
            await cli.promote(config('staging'), promoteOptions('staging'));
            const [write] = memory.log.filter((entry) => entry.op.startsWith('put'));
            expect(write).toMatchObject({ op: 'putIfMatch', key: 'releases/staging/manifest.json', condition: { ifMatch: base } });
        });

        test.each([[412], [409]])('a competing publication between the read and the write is a conflict (HTTP %i): nothing is overwritten or retried', async (status) => {
            memory.conflictStatus = status;
            memory.before = (op, bucket, key) => {
                if (op === 'putIfMatch' && key === 'releases/staging/manifest.json') {
                    memory.before = null;
                    seedManifest('staging', { sequence: 9 });
                }
            };
            const error = await cli.promote(config('staging'), promoteOptions('staging')).catch((failure) => failure);
            expect(error).toBeInstanceOf(ops.PublicationConflictError);
            expect(error.message).toMatch(/replaced while this promotion was running/);
            expect(error.message).toMatch(/the live manifest is sequence 9/);
            expect(error.message).toMatch(/Prepare a new candidate from the current state/);
            expect(world.writes).toEqual([]);
            expect(liveOf('staging').sequence).toBe(9);
            expect(memory.log.filter((entry) => entry.op === 'putIfMatch')).toHaveLength(1);
        });

        test('detects a concurrent publisher that overwrites the manifest right after the write', async () => {
            memory.after = (op, bucket, key) => {
                if (key === 'releases/staging/manifest.json') seedManifest('staging', { sequence: 99 });
            };
            const error = await cli.promote(config('staging'), promoteOptions('staging')).catch((failure) => failure);
            expect(error).toBeInstanceOf(Error);
            expect(error.message).toMatch(/not the one written/);
            expect(error.message).toMatch(/may already be live/);
            expect(error.message).toMatch(/rollback or a withdrawal/);
        });

        describe('a manifest write whose answer is lost', () => {
            const isManifest = (key) => key === 'releases/staging/manifest.json';

            test('not applied: the live manifest is unchanged and the same promote may be run again', async () => {
                memory.failNext('put', isManifest, { message: 'socket hang up' });
                const error = await cli.promote(config('staging'), promoteOptions('staging')).catch((failure) => failure);
                expect(error).toBeInstanceOf(ops.WriteNotAppliedError);
                expect(error.message).toMatch(/nothing was written/);
                expect(liveOf('staging').sequence).toBe(4);
                await cli.promote(config('staging'), promoteOptions('staging'));
                expect(liveOf('staging').sequence).toBe(5);
            });

            test('applied: the live manifest is the candidate, so the promotion is recognised as done', async () => {
                memory.failNext('put', isManifest, { apply: true, message: 'socket hang up' });
                await cli.promote(config('staging'), promoteOptions('staging'));
                expect(liveOf('staging').sequence).toBe(5);
                expect(output.join('')).toContain('Promoted launcher 3.2.11 sequence 5 to staging');
            });

            test('overtaken: somebody else published meanwhile, so it is a conflict, not a success', async () => {
                memory.failNext('put', isManifest, { message: 'socket hang up' });
                memory.before = (op, bucket, key) => {
                    if (op === 'putIfMatch' && isManifest(key)) {
                        memory.before = null;
                        seedManifest('staging', { sequence: 9 });
                    }
                };
                const error = await cli.promote(config('staging'), promoteOptions('staging')).catch((failure) => failure);
                expect(error).toBeInstanceOf(ops.PublicationConflictError);
                expect(error.message).toMatch(/not the one this bundle was based on/);
                expect(liveOf('staging').sequence).toBe(9);
            });

            test('and the live manifest cannot be read afterwards: says so and sends the operator to verify', async () => {
                memory.failNext('put', isManifest, { message: 'socket hang up' });
                let manifestReads = 0;
                cli.deps.openStore.mockImplementation((cfg, opts) => {
                    const store = memory.store(cfg.bucket, opts);
                    return {
                        ...store,
                        // the first read is the promote's own; the second is the look after the lost answer
                        get: async (key) => {
                            if (isManifest(key)) {
                                manifestReads += 1;
                                if (manifestReads === 2) throw new Error('dns failure');
                            }
                            return store.get(key);
                        }
                    };
                });
                const error = await cli.promote(config('staging'), promoteOptions('staging')).catch((failure) => failure);
                expect(error.message).toMatch(/may or may not have changed: run verify/);
            });
        });

        test('reports a public edge that does not serve the new manifest', async () => {
            world.edgeFrozen = liveOf('staging');
            await expect(cli.promote(config('staging'), promoteOptions('staging')))
                .rejects.toThrow(/public manifest does not match.*release is live in R2/s);
            expect(liveOf('staging').sequence).toBe(5);
        });

        test('refuses an installer that the public route serves', async () => {
            world.site.publicInstaller = 200;
            await expect(cli.promote(config('staging'), promoteOptions('staging')))
                .rejects.toThrow(/publicly reachable/);
        });

        test('cannot be promoted twice', async () => {
            await cli.promote(config('staging'), promoteOptions('staging'));
            world.writes.length = 0;
            await expect(cli.promote(config('staging'), promoteOptions('staging'))).rejects.toThrow(/changed after this bundle was prepared/);
            expect(world.writes).toEqual([]);
        });
    });

    describe('production follows staging with different bytes from the same release', () => {
        test('the same commit and version, different profiles and hashes, end to end', async () => {
            await publishOnStaging();
            await cli.prepare(config('production'), prepareOptions('production'));
            await cli.stage(config('production'), releaseOptions('production'));
            await cli.promote(config('production'), promoteOptions('production'));

            const staging = liveOf('staging').launcher.platforms['windows-x64'];
            const production = liveOf('production').launcher.platforms['windows-x64'];
            expect(liveOf('staging').launcher.version).toBe(liveOf('production').launcher.version);
            expect(production.sha256).not.toBe(staging.sha256);
            expect(production.sha256).toBe(candidates.production.sha256);
            expect(staging.sha256).toBe(candidates.staging.sha256);
            // production wrote only to the production bucket
            expect(world.writes.filter((full) => full.startsWith('bucket-production/')).length).toBe(4);
            const productionRelease = readBundle('production', { sequence: 3 }).metadata;
            expect(productionRelease.sourceCommit).toBe(liveReleaseCommit());
            expect(liveOf('production').client).toEqual(OLD_CLIENT);
        });

        function liveReleaseCommit() {
            return readBundle('staging', { sequence: 5 }).metadata.sourceCommit;
        }

        test('promotion to production re-checks staging', async () => {
            await publishOnStaging();
            await cli.prepare(config('production'), prepareOptions('production'));
            await cli.stage(config('production'), releaseOptions('production'));
            seedManifest('staging', { sequence: 6, launcher: null });
            await expect(cli.promote(config('production'), promoteOptions('production'))).rejects.toThrow(/staging first/);
            expect(liveOf('production').sequence).toBe(2);
        });
    });

    describe('client and launcher releases keep each other', () => {
        test('a launcher release keeps the client and a stale client bundle can no longer be staged', async () => {
            await cli.prepare(config('staging'), prepareOptions('staging'));
            const staleClientPayload = { launcher: null, client: OLD_CLIENT };
            await cli.stage(config('staging'), releaseOptions('staging'));
            await cli.promote(config('staging'), promoteOptions('staging'));
            expect(liveOf('staging').client).toEqual(OLD_CLIENT);
            // what the client CLI runs before it stages or promotes
            expect(() => launcherRelease.requireClientReleaseKeepsLauncher(staleClientPayload, liveOf('staging')))
                .toThrow(/live launcher entry/);
            expect(() => launcherRelease.requireClientReleaseKeepsLauncher({ launcher: liveOf('staging').launcher, client: OLD_CLIENT }, liveOf('staging')))
                .not.toThrow();
        });
    });

    describe('rollback and withdrawal', () => {
        async function publishLauncher(sequence, version, bytes) {
            const dir = path.join(directory, 'candidates', `staging-${version}`);
            fs.mkdirSync(dir, { recursive: true });
            const name = `Microbot-Cut-Launcher-Setup-${version}.exe`;
            fs.writeFileSync(path.join(dir, name), bytes);
            const record = { ...candidateFor('staging', bytes), version, file: name };
            fs.writeFileSync(path.join(dir, 'candidate.json'), JSON.stringify(record));
            await cli.prepare(config('staging'), {
                version, candidate: dir, 'validated-sha256': record.sha256
            });
            await cli.stage(config('staging'), { version, sequence });
            await cli.promote(config('staging'), { version, sequence, 'confirm-promote': true });
        }

        test('rolls back to a previous launcher without uploading it again', async () => {
            await publishLauncher(5, '3.2.11', crypto.randomBytes(1024));
            await publishLauncher(6, '3.2.12', crypto.randomBytes(1024));
            expect(liveOf('staging').launcher.version).toBe('3.2.12');

            world.writes.length = 0;
            await cli.prepareRollback(config('staging'), { version: '3.2.11', 'source-sequence': 5 });
            await cli.stage(config('staging'), { version: '3.2.11', sequence: 7 });
            expect(world.writes).toEqual([candidateKey('staging', 7)]);
            await cli.promote(config('staging'), { version: '3.2.11', sequence: 7, 'confirm-promote': true });
            expect(liveOf('staging').sequence).toBe(7);
            expect(liveOf('staging').launcher.version).toBe('3.2.11');
            expect(output.join('')).toContain('does not downgrade launchers that are already installed');
        });

        test('a rollback needs the old objects to still be in R2', async () => {
            await publishLauncher(5, '3.2.11', crypto.randomBytes(1024));
            await publishLauncher(6, '3.2.12', crypto.randomBytes(1024));
            await cli.prepareRollback(config('staging'), { version: '3.2.11', 'source-sequence': 5 });
            world.r2.delete(bucketKey('staging', launcherRelease.launcherObjectKeys('3.2.11').installer));
            await expect(cli.stage(config('staging'), { version: '3.2.11', sequence: 7 })).rejects.toThrow(/no longer available/);
            expect(world.writes.filter((full) => full.includes('sequence-7'))).toEqual([]);
        });

        test('a rollback is prepared against the live client, so it cannot revert a client release', async () => {
            await publishLauncher(5, '3.2.11', crypto.randomBytes(1024));
            await publishLauncher(6, '3.2.12', crypto.randomBytes(1024));
            const newClient = { ...OLD_CLIENT, version: 'cut-2.6.31', sha256: '1'.repeat(64) };
            seedManifest('staging', { sequence: 7, launcher: liveOf('staging').launcher, client: newClient });
            await cli.prepareRollback(config('staging'), { version: '3.2.11', 'source-sequence': 5 });
            expect(readBundle('staging', { sequence: 8 }).payload.client).toEqual(newClient);
            seedManifest('staging', { sequence: 7, launcher: liveOf('staging').launcher, client: { ...newClient, sha256: '2'.repeat(64) } });
            rebase('staging', { version: '3.2.11', sequence: 8 });
            await expect(cli.stage(config('staging'), { version: '3.2.11', sequence: 8 })).rejects.toThrow(/live client entry/);
        });

        test('a withdrawal hides the installer and keeps the client', async () => {
            await publishLauncher(5, '3.2.11', crypto.randomBytes(1024));
            world.writes.length = 0;
            await cli.prepareWithdraw(config('staging'), {});
            await cli.stage(config('staging'), { withdrawal: true, sequence: 6 });
            expect(world.writes).toEqual([candidateKey('staging', 6)]);
            await cli.promote(config('staging'), { withdrawal: true, sequence: 6, 'confirm-promote': true });
            expect(liveOf('staging').launcher).toBeNull();
            expect(liveOf('staging').client).toEqual(OLD_CLIENT);
        });
    });

    describe('verify', () => {
        test('confirms the manifest, the R2 objects and the closed public prefix', async () => {
            await cli.prepare(config('staging'), prepareOptions('staging'));
            await cli.stage(config('staging'), releaseOptions('staging'));
            await cli.promote(config('staging'), promoteOptions('staging'));
            await cli.verify(config('staging'), releaseOptions('staging'));
            expect(output.join('')).toContain('Verified staging launcher 3.2.11 sequence 5');
        });

        test('detects an R2 object that no longer matches, and a manifest that is not the bundle', async () => {
            await cli.prepare(config('staging'), prepareOptions('staging'));
            await cli.stage(config('staging'), releaseOptions('staging'));
            await cli.promote(config('staging'), promoteOptions('staging'));
            world.r2.set(bucketKey('staging', KEYS.installer), Buffer.from('changed'));
            await expect(cli.verify(config('staging'), releaseOptions('staging'))).rejects.toThrow(/does not match the release bundle/);
            seedManifest('staging', { sequence: 6 });
            await expect(cli.verify(config('staging'), releaseOptions('staging'))).rejects.toThrow(/public manifest does not match/);
        });
    });

    describe('requireSiteRoutes', () => {
        test('accepts a Worker that protects the download route and closes the public prefix', async () => {
            await expect(cli.requireSiteRoutes(config('staging'))).resolves.toBeUndefined();
            const urls = cli.deps.fetchResponse.mock.calls.map(([url]) => new URL(url).pathname);
            expect(urls).toEqual([
                '/api/v1/downloads/launcher',
                '/api/v1/releases/artifacts/launcher/0.0.0/windows/Microbot-Cut-Launcher-Setup-0.0.0.exe'
            ]);
        });
    });

    describe('dry run', () => {
        beforeEach(async () => {
            await cli.prepare(config('staging'), prepareOptions('staging'));
        });

        const argv = (command, ...extra) => [
            command, '--version', VERSION, '--sequence', '5', '--config', channels.staging.configPath,
            '--staging-config', channels.staging.configPath, ...extra
        ];
        const putAttempts = () => memory.log.filter((entry) => entry.op.startsWith('put'));

        test('stage reports what it would upload and writes nothing', async () => {
            await cli.main(argv('stage', '--dry-run'));
            expect(world.writes).toEqual([]);
            expect(output.join('')).toContain(`would upload installer: ${KEYS.installer}`);
            expect(output.join('')).toContain('Dry run: nothing was written to R2.');
            expect(fs.existsSync(path.join(cli.deps.workRoot, 'staging.publish.lock'))).toBe(false);
        });

        test('every store a dry run opens is read-only, so a write is impossible rather than merely avoided', async () => {
            await cli.stage(config('staging'), releaseOptions('staging'));
            cli.deps.openStore.mockClear();
            await cli.main(argv('stage', '--dry-run', '--resume'));
            await cli.main(argv('promote', '--dry-run'));
            expect(cli.deps.openStore).toHaveBeenCalled();
            for (const [, options] of cli.deps.openStore.mock.calls) expect(options).toEqual({ writable: false });
            const store = cli.deps.openStore.mock.results[0].value;
            await expect(store.putIfMatch('releases/staging/manifest.json', Buffer.from('x'), 'application/json', '"e"')).rejects.toThrow(/read-only/);
            await expect(store.putIfAbsent('k', Buffer.from('x'), 'application/json')).rejects.toThrow(/read-only/);
        });

        test('promote passes every check and writes nothing', async () => {
            await cli.stage(config('staging'), releaseOptions('staging'));
            world.writes.length = 0;
            memory.log.length = 0;
            await cli.main(argv('promote', '--dry-run'));
            expect(world.writes).toEqual([]);
            expect(putAttempts()).toEqual([]);
            expect(liveOf('staging').sequence).toBe(4);
            expect(output.join('')).toContain('passed every check');
            expect(output.join('')).toContain('written only if the live ETag is still');
        });

        test('a dry run still fails on a problem a real run would hit', async () => {
            await cli.stage(config('staging'), releaseOptions('staging'));
            world.r2.set(bucketKey('staging', KEYS.installer), Buffer.from('tampered'));
            await expect(cli.main(argv('promote', '--dry-run'))).rejects.toThrow(/staged installer does not match/);
        });

        test('through the real S3 transport, no PUT request leaves the process', async () => {
            const fetchMock = createMemoryFetch(memory);
            cli.deps.openStore.mockImplementation((cfg, options) => createR2Store({
                bucket: cfg.bucket, accountId: 'acct', accessKeyId: 'AK', secretAccessKey: 'SK', fetch: fetchMock, ...options
            }));
            await cli.main(argv('stage', '--dry-run'));
            expect(fetchMock.requests.length).toBeGreaterThan(0);
            expect(fetchMock.requests.map((request) => request.method).filter((method) => !['GET', 'HEAD'].includes(method))).toEqual([]);
            await cli.stage(config('staging'), releaseOptions('staging'));
            fetchMock.requests.length = 0;
            await cli.main(argv('promote', '--dry-run'));
            expect(fetchMock.requests.length).toBeGreaterThan(0);
            expect(fetchMock.requests.every((request) => ['GET', 'HEAD'].includes(request.method))).toBe(true);
        });
    });

    describe('through the real S3 transport', () => {
        test('stage and promote send the documented signed requests, in order, each write conditional', async () => {
            await cli.prepare(config('staging'), prepareOptions('staging'));
            const base = memory.etag('bucket-staging', 'releases/staging/manifest.json');
            const fetchMock = createMemoryFetch(memory);
            cli.deps.openStore.mockImplementation((cfg, options) => createR2Store({
                bucket: cfg.bucket, accountId: 'acct', accessKeyId: 'AK', secretAccessKey: 'SK', fetch: fetchMock, ...options
            }));
            await cli.stage(config('staging'), releaseOptions('staging'));
            await cli.promote(config('staging'), promoteOptions('staging'));
            const puts = fetchMock.requests.filter((request) => request.method === 'PUT');
            expect(puts.map((request) => request.key)).toEqual([
                KEYS.installer,
                KEYS.updater,
                'releases/staging/candidates/sequence-5-manifest.json',
                'releases/staging/manifest.json'
            ]);
            for (const request of puts.slice(0, 3)) {
                expect(request.headers['if-none-match']).toBe('*');
                expect(request.headers['if-match']).toBeUndefined();
            }
            expect(puts[3].headers['if-match']).toBe(base);
            expect(puts[3].headers['if-none-match']).toBeUndefined();
            for (const request of fetchMock.requests) {
                expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request/);
            }
            expect(liveOf('staging').sequence).toBe(5);
        });
    });

    describe('concurrent publications', () => {
        const argv = (command) => [
            command, '--version', VERSION, '--sequence', '5', '--config', channels.staging.configPath,
            '--staging-config', channels.staging.configPath
        ];
        const lockPath = () => path.join(cli.deps.workRoot, 'staging.publish.lock');

        beforeEach(async () => {
            await cli.prepare(config('staging'), prepareOptions('staging'));
        });

        test('a second publisher on the same channel is refused and writes nothing', async () => {
            fs.mkdirSync(cli.deps.workRoot, { recursive: true });
            fs.writeFileSync(lockPath(), JSON.stringify({
                pid: process.pid, host: os.hostname(), command: 'client promote x', startedAt: '2026-10-12T00:00:00.000Z'
            }));
            await expect(cli.main(argv('stage'))).rejects.toThrow(/another publication holds the staging lock.*client promote x/);
            expect(world.writes).toEqual([]);
            expect(fs.existsSync(lockPath())).toBe(true);
        });

        test('the lock is released after success and after failure', async () => {
            await cli.main(argv('stage'));
            expect(fs.existsSync(lockPath())).toBe(false);
            await expect(cli.main(argv('stage'))).rejects.toThrow(/already exists/);
            expect(fs.existsSync(lockPath())).toBe(false);
        });

        test('a lock left by a process that no longer exists is cleared', async () => {
            fs.mkdirSync(cli.deps.workRoot, { recursive: true });
            fs.writeFileSync(lockPath(), JSON.stringify({ pid: 2147483000, host: os.hostname(), command: 'stage', startedAt: 'x' }));
            await cli.main(argv('stage'));
            expect(world.writes.length).toBe(3);
        });

        test('a lock from another machine is never cleared automatically', async () => {
            fs.mkdirSync(cli.deps.workRoot, { recursive: true });
            fs.writeFileSync(lockPath(), JSON.stringify({ pid: 1, host: 'some-other-machine', command: 'stage', startedAt: 'x' }));
            await expect(cli.main(argv('stage'))).rejects.toThrow(/another publication holds/);
        });

        test('two staged sequences cannot both become live: the late one is refused', async () => {
            await cli.stage(config('staging'), releaseOptions('staging'));
            // another publisher got sequence 5 live first (for example a client release)
            seedManifest('staging', { sequence: 5 });
            await expect(cli.promote(config('staging'), promoteOptions('staging'))).rejects.toThrow(/changed after this bundle was prepared/);
        });

        test('two prepares from the same live state compute the same sequence: the second cannot stage over the first', async () => {
            // machine A and machine B prepare the same next sequence (5) with different bytes
            const machineB = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-launcher-b-'));
            const workA = cli.deps.workRoot;
            cli.deps.workRoot = machineB;
            const other = path.join(directory, 'candidates', 'staging-b');
            fs.mkdirSync(other, { recursive: true });
            const bytes = crypto.randomBytes(2048);
            fs.writeFileSync(path.join(other, FILE_NAME), bytes);
            fs.writeFileSync(path.join(other, 'candidate.json'), JSON.stringify({ ...candidateFor('staging', bytes), sourceCommit: 'b'.repeat(40) }));
            try {
                await cli.prepare(config('staging'), prepareOptions('staging', { candidate: other, 'validated-sha256': crypto.createHash('sha256').update(bytes).digest('hex') }));
                expect(readBundle('staging', { sequence: 5 }).payload.sequence).toBe(5);

                // A stages and promotes first
                cli.deps.workRoot = workA;
                await cli.stage(config('staging'), releaseOptions('staging'));
                await cli.promote(config('staging'), promoteOptions('staging'));
                expect(liveOf('staging').sequence).toBe(5);

                // B finds its base gone and its objects in the way: nothing is written
                cli.deps.workRoot = machineB;
                world.writes.length = 0;
                await expect(cli.stage(config('staging'), releaseOptions('staging'))).rejects.toThrow(/changed after this bundle was prepared/);
                await expect(cli.promote(config('staging'), promoteOptions('staging'))).rejects.toThrow(/changed after this bundle was prepared/);
                expect(world.writes).toEqual([]);
            } finally {
                cli.deps.workRoot = workA;
                fs.rmSync(machineB, { recursive: true, force: true });
            }
        });

        test('the candidate key is shared by both prepares, so a stage that races the other one is refused by R2', async () => {
            // another publisher staged a different candidate for sequence 5 between this stage's check and its write
            memory.before = (op, bucket, key) => {
                if (op === 'putIfAbsent' && key === 'releases/staging/candidates/sequence-5-manifest.json') {
                    memory.before = null;
                    memory.seed(bucket, key, Buffer.from('another candidate'));
                }
            };
            await expect(cli.stage(config('staging'), releaseOptions('staging'))).rejects.toThrow(/created by another publication with different bytes/);
            expect(world.writes).toEqual([bucketKey('staging', KEYS.installer), bucketKey('staging', KEYS.updater)]);
            expect(memory.bytes('bucket-staging', 'releases/staging/candidates/sequence-5-manifest.json').toString()).toBe('another candidate');
        });
    });
});
