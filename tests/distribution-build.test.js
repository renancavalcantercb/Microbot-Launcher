const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const asar = require('@electron/asar');

const build = require('../libs/distribution-build');
const profileLib = require('../libs/distribution-profile');
const { createRuntimeFixture } = require('./helpers/runtime-fixture');

const root = path.join(__dirname, '..');
const SOURCE = { commit: 'b'.repeat(40), version: '3.2.11' };
const runtimeFixture = createRuntimeFixture();
const RUNTIME = runtimeFixture.pin;
afterAll(() => runtimeFixture.cleanup());

function placeRuntime(destination) {
    fs.cpSync(runtimeFixture.dir, destination, { recursive: true });
}

async function withTempDir(callback) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-build-'));
    try {
        return await callback(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('build arguments', () => {
    test('a profile is mandatory and has no default', () => {
        expect(() => build.parseBuildArguments([])).toThrow('profile is required');
        expect(() => build.parseBuildArguments(['--profile'])).toThrow('profile is required');
        expect(() => build.parseBuildArguments(['--profile', 'dev'])).toThrow('profile is required');
        expect(() => build.parseBuildArguments(['--profile', 'localhost'])).toThrow('profile is required');
    });

    test('accepts exactly staging and production', () => {
        expect(build.parseBuildArguments(['--profile', 'staging']).profile).toBe('staging');
        expect(build.parseBuildArguments(['--profile', 'production', '--allow-dirty']))
            .toMatchObject({ profile: 'production', allowDirty: true });
    });

    test('rejects unknown arguments', () => {
        expect(() => build.parseBuildArguments(['--profile', 'staging', '--debug'])).toThrow('unknown build argument');
    });

    test('the build script exits non-zero without a profile and without touching the tree', () => {
        const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-distribution.js')], {
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, MICROBOT_CUT_API_BASE_URL: 'http://localhost:5173/api/v1' }
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('a distribution profile is required');
        expect(fs.existsSync(path.join(root, profileLib.PROFILE_FILE))).toBe(false);
    });
});

describe('beforePack hook', () => {
    test('is configured in package.json', () => {
        const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        expect(packageJson.build.beforePack).toBe('scripts/require-distribution-profile.js');
        expect(require('../scripts/require-distribution-profile')).toBe(build.requireDistributionProfile);
    });

    test('fails when the profile file is missing', async () => {
        await withTempDir(async (dir) => {
            await expect(build.requireDistributionProfile({ packager: { projectDir: dir } }))
                .rejects.toThrow('missing or unreadable');
        });
    });

    test('fails when the profile is invalid or has no source', async () => {
        await withTempDir(async (dir) => {
            const raw = JSON.parse(fs.readFileSync(path.join(root, 'config', 'distribution', 'staging.json'), 'utf8'));
            fs.writeFileSync(path.join(dir, profileLib.PROFILE_FILE), JSON.stringify(raw));
            await expect(build.requireDistributionProfile({ packager: { projectDir: dir } }))
                .rejects.toThrow('source');
            raw.api.baseUrl = 'http://localhost:5173/api/v1';
            raw.source = SOURCE;
            fs.writeFileSync(path.join(dir, profileLib.PROFILE_FILE), JSON.stringify(raw));
            await expect(build.requireDistributionProfile({ packager: { projectDir: dir } }))
                .rejects.toThrow('HTTPS');
        });
    });

    test('passes with a valid embedded profile', async () => {
        await withTempDir(async (dir) => {
            const profile = profileLib.loadProfileSource({ fs, path, root, name: 'production' });
            fs.writeFileSync(path.join(dir, profileLib.PROFILE_FILE), profileLib.serializeEmbeddedProfile(profile, SOURCE, RUNTIME));
            placeRuntime(path.join(dir, build.RUNTIME_SOURCE_DIRECTORY));
            await expect(build.requireDistributionProfile({ packager: { projectDir: dir } })).resolves.toBeUndefined();
        });
    });

    test('fails when the runtime to embed is missing, modified or not the pinned one', async () => {
        await withTempDir(async (dir) => {
            const profile = profileLib.loadProfileSource({ fs, path, root, name: 'production' });
            fs.writeFileSync(path.join(dir, profileLib.PROFILE_FILE), profileLib.serializeEmbeddedProfile(profile, SOURCE, RUNTIME));
            const image = path.join(dir, build.RUNTIME_SOURCE_DIRECTORY);
            await expect(build.requireDistributionProfile({ packager: { projectDir: dir } }))
                .rejects.toThrow('the Java runtime to embed');
            placeRuntime(image);
            fs.writeFileSync(path.join(image, 'lib', 'modules'), 'tampered');
            await expect(build.requireDistributionProfile({ packager: { projectDir: dir } }))
                .rejects.toThrow('modified file');
            fs.rmSync(image, { recursive: true, force: true });
            placeRuntime(image);
            fs.writeFileSync(
                path.join(dir, profileLib.PROFILE_FILE),
                profileLib.serializeEmbeddedProfile(profile, SOURCE, { ...RUNTIME, imageSha256: 'f'.repeat(64) })
            );
            await expect(build.requireDistributionProfile({ packager: { projectDir: dir } }))
                .rejects.toThrow('does not match');
        });
    });
});

describe('installer identity', () => {
    const identityOf = (name) => profileLib.loadProfileSource({ fs, path, root, name }).identity;
    test.each(['staging', 'production'])('%s builder arguments carry its identity', (name) => {
        const identity = identityOf(name);
        expect(build.identityBuilderArguments(identity)).toEqual([
            `--config.appId=${identity.appId}`,
            `--config.productName=${identity.productName}`,
            `--config.nsis.shortcutName=${identity.shortcutName}`,
            `--config.nsis.uninstallDisplayName=${identity.productName}`
        ]);
    });

    test.each(['staging', 'production'])('accepts the %s executable', (name) => {
        const identity = identityOf(name);
        expect(build.verifyInstallerIdentity({
            identity, executableName: `${identity.productName}.exe`, executableProductName: identity.productName
        })).toEqual({ executableName: `${identity.productName}.exe`, productName: identity.productName });
    });

    test('rejects an executable built with the other environment identity', () => {
        const staging = identityOf('staging');
        const production = identityOf('production');
        expect(() => build.verifyInstallerIdentity({
            identity: staging, executableName: `${production.productName}.exe`, executableProductName: staging.productName
        })).toThrow('executable');
        expect(() => build.verifyInstallerIdentity({
            identity: staging, executableName: `${staging.productName}.exe`, executableProductName: production.productName
        })).toThrow('product name');
    });

    test('the Windows package does not list the macOS-only instructions', () => {
        const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        expect(packageJson.build.files.join('\n')).not.toMatch(/READ THIS BEFORE INSTALL/);
        expect(packageJson.build.files.some((entry) => /^build\b/.test(entry))).toBe(false);
    });
});

describe('macOS-only files', () => {
    test('are rejected in the packed Windows app', async () => {
        const profileText = profileLib.serializeEmbeddedProfile(
            profileLib.loadProfileSource({ fs, path, root, name: 'staging' }), SOURCE, RUNTIME);
        await withTempDir(async (dir) => {
            const app = path.join(dir, 'app');
            fs.mkdirSync(path.join(app, 'node_modules', 'axios'), { recursive: true });
            fs.mkdirSync(path.join(app, 'build'));
            fs.writeFileSync(path.join(app, 'node_modules', 'axios', 'package.json'), '{}');
            fs.writeFileSync(path.join(app, 'build', 'READ THIS BEFORE INSTALL.html'), '<html/>');
            fs.writeFileSync(path.join(app, 'product-config.js'), 'module.exports = { updateFilesBase: null };');
            fs.writeFileSync(path.join(app, profileLib.PROFILE_FILE), profileText);
            fs.mkdirSync(path.join(dir, 'resources'));
            const asarPath = path.join(dir, 'resources', 'app.asar');
            await asar.createPackage(app, asarPath);
            expect(() => build.verifyPackedApp({
                asarApi: asar, asarPath, resourcesDirectory: path.join(dir, 'resources'),
                expectedProfileText: profileText, dependencies: ['axios']
            })).toThrow('macOS-only');
        });
    });
});

describe('embedProfile', () => {
    test('writes the profile, refuses a leftover and cleans up', () => withTempDir((dir) => {
        fs.mkdirSync(path.join(dir, 'config', 'distribution'), { recursive: true });
        for (const name of ['staging', 'production']) {
            fs.copyFileSync(
                path.join(root, 'config', 'distribution', `${name}.json`),
                path.join(dir, 'config', 'distribution', `${name}.json`)
            );
        }
        fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'config', 'java-runtime.json'),
            JSON.stringify({ javaVersion: RUNTIME.javaVersion, image: { sha256: RUNTIME.imageSha256 } })
        );
        placeRuntime(path.join(dir, build.RUNTIME_SOURCE_DIRECTORY));
        const embedded = build.embedProfile({ root: dir, name: 'staging', commit: SOURCE.commit, version: SOURCE.version });
        const file = path.join(dir, profileLib.PROFILE_FILE);
        expect(fs.readFileSync(file, 'utf8')).toBe(embedded.text);
        expect(profileLib.loadEmbeddedProfile({ fs, path, root: dir }).source).toEqual(SOURCE);
        expect(profileLib.loadEmbeddedProfile({ fs, path, root: dir }).embeddedRuntime).toEqual(RUNTIME);
        expect(() => build.embedProfile({ root: dir, name: 'staging', commit: SOURCE.commit, version: SOURCE.version }))
            .toThrow('already exists');
        embedded.cleanup();
        expect(fs.existsSync(file)).toBe(false);
        expect(() => build.embedProfile({ root: dir, name: undefined, commit: SOURCE.commit, version: SOURCE.version }))
            .toThrow('profile is required');
    }));

    test('refuses to embed without a pinned runtime digest or with a different image', () => withTempDir((dir) => {
        fs.mkdirSync(path.join(dir, 'config', 'distribution'), { recursive: true });
        fs.copyFileSync(
            path.join(root, 'config', 'distribution', 'staging.json'),
            path.join(dir, 'config', 'distribution', 'staging.json')
        );
        const args = { root: dir, name: 'staging', commit: SOURCE.commit, version: SOURCE.version };
        expect(() => build.embedProfile(args)).toThrow('java-runtime.json');
        fs.writeFileSync(
            path.join(dir, 'config', 'java-runtime.json'),
            JSON.stringify({ javaVersion: RUNTIME.javaVersion, image: { sha256: null } })
        );
        expect(() => build.embedProfile(args)).toThrow('no image digest');
        fs.writeFileSync(
            path.join(dir, 'config', 'java-runtime.json'),
            JSON.stringify({ javaVersion: RUNTIME.javaVersion, image: { sha256: 'f'.repeat(64) } })
        );
        placeRuntime(path.join(dir, build.RUNTIME_SOURCE_DIRECTORY));
        expect(() => build.embedProfile(args)).toThrow('does not match');
        expect(fs.existsSync(path.join(dir, profileLib.PROFILE_FILE))).toBe(false);
    }));

    test('the staging and production builds of one commit differ only by their profile', () => {
        const staging = profileLib.serializeEmbeddedProfile(
            profileLib.loadProfileSource({ fs, path, root, name: 'staging' }), SOURCE, RUNTIME);
        const production = profileLib.serializeEmbeddedProfile(
            profileLib.loadProfileSource({ fs, path, root, name: 'production' }), SOURCE, RUNTIME);
        expect(staging).not.toBe(production);
        expect(JSON.parse(staging).source).toEqual(JSON.parse(production).source);
    });
});

describe('packed app verification', () => {
    async function packApp(dir, { profileText, productConfig, packages, updateFeed = false, runtime = true }) {
        const app = path.join(dir, 'app');
        fs.mkdirSync(path.join(app, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(app, 'product-config.js'), productConfig);
        if (profileText !== null) fs.writeFileSync(path.join(app, profileLib.PROFILE_FILE), profileText);
        for (const name of packages) {
            fs.mkdirSync(path.join(app, 'node_modules', name), { recursive: true });
            fs.writeFileSync(path.join(app, 'node_modules', name, 'package.json'), '{}');
        }
        const resources = path.join(dir, 'resources');
        fs.mkdirSync(resources);
        const asarPath = path.join(resources, 'app.asar');
        await asar.createPackage(app, asarPath);
        if (updateFeed) fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: generic');
        if (runtime) placeRuntime(path.join(resources, 'java-runtime'));
        return { asarPath, resourcesDirectory: resources };
    }

    const profileText = profileLib.serializeEmbeddedProfile(
        profileLib.loadProfileSource({ fs, path, root, name: 'staging' }), SOURCE, RUNTIME);
    const goodConfig = 'module.exports = { updateFilesBase: null };';
    const dependencies = ['axios', '@scope/pkg'];

    test('accepts a complete app and reports the profile hash', async () => {
        await withTempDir(async (dir) => {
            const packed = await packApp(dir, { profileText, productConfig: goodConfig, packages: ['axios', '@scope/pkg', 'extra'] });
            const result = build.verifyPackedApp({ asarApi: asar, ...packed, expectedProfileText: profileText, dependencies });
            expect(result.packageCount).toBe(3);
            expect(result.embeddedProfileSha256).toBe(build.sha256(Buffer.from(profileText)));
        });
    });

    test('rejects an app whose Java runtime was modified after packing', async () => {
        await withTempDir(async (dir) => {
            const packed = await packApp(dir, { profileText, productConfig: goodConfig, packages: ['axios', '@scope/pkg'] });
            fs.writeFileSync(path.join(packed.resourcesDirectory, 'java-runtime', 'bin', 'javaw.exe'), 'evil');
            expect(() => build.verifyPackedApp({ asarApi: asar, ...packed, expectedProfileText: profileText, dependencies }))
                .toThrow('wrong Java runtime');
        });
    });

    test.each([
        ['has no embedded profile', { profileText: null }, 'no embedded distribution profile'],
        ['embeds a different profile', { profileText: '{}\n' }, 'differs'],
        ['enables a launcher update feed', { productConfig: 'module.exports = { updateFilesBase: "https://x" };' }, 'auto-update'],
        ['ships an updater feed file', { updateFeed: true }, 'app-update.yml'],
        ['lost a dependency (broken node_modules)', { packages: ['axios'] }, 'missing dependencies: @scope/pkg'],
        ['carries no Java runtime', { runtime: false }, 'wrong Java runtime']
    ])('rejects an app that %s', async (_label, overrides, fragment) => {
        await withTempDir(async (dir) => {
            const packed = await packApp(dir, {
                profileText, productConfig: goodConfig, packages: ['axios', '@scope/pkg'], ...overrides
            });
            expect(() => build.verifyPackedApp({ asarApi: asar, ...packed, expectedProfileText: profileText, dependencies }))
                .toThrow(fragment);
        });
    });
});
