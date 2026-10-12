const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const asar = require('@electron/asar');

const build = require('../libs/distribution-build');
const profileLib = require('../libs/distribution-profile');

const root = path.join(__dirname, '..');
const SOURCE = { commit: 'b'.repeat(40), version: '3.2.11' };

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
            fs.writeFileSync(path.join(dir, profileLib.PROFILE_FILE), profileLib.serializeEmbeddedProfile(profile, SOURCE));
            await expect(build.requireDistributionProfile({ packager: { projectDir: dir } })).resolves.toBeUndefined();
        });
    });
});

describe('installer identity', () => {
    const identityOf = (name) => profileLib.loadProfileSource({ fs, path, root, name }).identity;
    const effectiveText = (identity) => [
        `appId: ${identity.appId}`,
        `productName: ${identity.productName}`,
        'nsis:',
        '  oneClick: false',
        `  shortcutName: ${identity.shortcutName}`,
        ''
    ].join('\n');

    test.each(['staging', 'production'])('%s builder arguments carry its identity', (name) => {
        const identity = identityOf(name);
        expect(build.identityBuilderArguments(identity)).toEqual([
            `--config.appId=${identity.appId}`,
            `--config.productName=${identity.productName}`,
            `--config.nsis.shortcutName=${identity.shortcutName}`,
            `--config.nsis.uninstallDisplayName=${identity.productName}`
        ]);
    });

    test.each(['staging', 'production'])('accepts the %s effective configuration', (name) => {
        const identity = identityOf(name);
        expect(build.verifyInstallerIdentity({
            effectiveConfigText: effectiveText(identity), identity, executableName: `${identity.productName}.exe`
        })).toEqual({ appId: identity.appId, productName: identity.productName, shortcutName: identity.shortcutName });
    });

    test('rejects an installer built with the other environment identity', () => {
        const staging = identityOf('staging');
        const production = identityOf('production');
        expect(() => build.verifyInstallerIdentity({
            effectiveConfigText: effectiveText(production), identity: staging, executableName: `${staging.productName}.exe`
        })).toThrow('appId');
        expect(() => build.verifyInstallerIdentity({
            effectiveConfigText: effectiveText(staging), identity: staging, executableName: `${production.productName}.exe`
        })).toThrow('executable');
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
            profileLib.loadProfileSource({ fs, path, root, name: 'staging' }), SOURCE);
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
        const embedded = build.embedProfile({ root: dir, name: 'staging', commit: SOURCE.commit, version: SOURCE.version });
        const file = path.join(dir, profileLib.PROFILE_FILE);
        expect(fs.readFileSync(file, 'utf8')).toBe(embedded.text);
        expect(profileLib.loadEmbeddedProfile({ fs, path, root: dir }).source).toEqual(SOURCE);
        expect(() => build.embedProfile({ root: dir, name: 'staging', commit: SOURCE.commit, version: SOURCE.version }))
            .toThrow('already exists');
        embedded.cleanup();
        expect(fs.existsSync(file)).toBe(false);
        expect(() => build.embedProfile({ root: dir, name: undefined, commit: SOURCE.commit, version: SOURCE.version }))
            .toThrow('profile is required');
    }));

    test('the staging and production builds of one commit differ only by their profile', () => {
        const staging = profileLib.serializeEmbeddedProfile(
            profileLib.loadProfileSource({ fs, path, root, name: 'staging' }), SOURCE);
        const production = profileLib.serializeEmbeddedProfile(
            profileLib.loadProfileSource({ fs, path, root, name: 'production' }), SOURCE);
        expect(staging).not.toBe(production);
        expect(JSON.parse(staging).source).toEqual(JSON.parse(production).source);
    });
});

describe('packed app verification', () => {
    async function packApp(dir, { profileText, productConfig, packages, updateFeed = false }) {
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
        return { asarPath, resourcesDirectory: resources };
    }

    const profileText = profileLib.serializeEmbeddedProfile(
        profileLib.loadProfileSource({ fs, path, root, name: 'staging' }), SOURCE);
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

    test.each([
        ['has no embedded profile', { profileText: null }, 'no embedded distribution profile'],
        ['embeds a different profile', { profileText: '{}\n' }, 'differs'],
        ['enables a launcher update feed', { productConfig: 'module.exports = { updateFilesBase: "https://x" };' }, 'auto-update'],
        ['ships an updater feed file', { updateFeed: true }, 'app-update.yml'],
        ['lost a dependency (broken node_modules)', { packages: ['axios'] }, 'missing dependencies: @scope/pkg']
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
