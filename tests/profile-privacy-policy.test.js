const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
    ProfilePrivacyPolicy,
    PrivacyPolicyError,
    POLICY_KEYS,
    MARKER_FILE,
    propertyKeys
} = require('../libs/profile-privacy-policy');
const { guardDirectory } = require('./helpers/legacy-write-guard');
const { createFakeLaunchHarness } = require('./helpers/fake-java-launch');

const SECRET_LINE = 'telegram.token=123456:SECRET-TOKEN-VALUE';

function sha(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('propertyKeys', () => {
    test('reads keys like Java properties: comments, separators, escapes and continuations', () => {
        const keys = propertyKeys(
            [
                '#comment=1',
                '! also a comment',
                'a.b=1',
                'c.d : 2',
                'e.f 3',
                'g\\=h=4',
                'long.key=one \\',
                '   two',
                'runelite.xptrackerplugin=true'
            ].join('\n')
        );
        expect([...keys].sort()).toEqual(
            ['a.b', 'c.d', 'e.f', 'g=h', 'long.key', 'runelite.xptrackerplugin'].sort()
        );
    });
});

describe('ProfilePrivacyPolicy', () => {
    let root;
    let runeliteDir;
    let profilesDir;
    let productDataDir;
    let log;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-policy-'));
        runeliteDir = path.join(root, '.runelite');
        profilesDir = path.join(runeliteDir, 'microbot-profiles');
        productDataDir = path.join(root, '.microbot-cut');
        fs.mkdirSync(profilesDir, { recursive: true });
        fs.mkdirSync(productDataDir);
        log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    function policy(options = {}) {
        return new ProfilePrivacyPolicy({
            fs: options.fs || fs,
            path,
            runeliteDir,
            productDataDir,
            log,
            sleep: async () => {},
            ...options
        });
    }

    function writeProfiles(profiles) {
        fs.writeFileSync(
            path.join(profilesDir, 'profiles.json'),
            JSON.stringify({ profiles: profiles.map((p) => ({ password: 'ENCRYPTED-PASSWORD', ...p })) })
        );
    }

    function profileFile(name, id) {
        return path.join(profilesDir, `${name}-${id}.properties`);
    }

    function setup({ content, name = 'main', id = 7 } = {}) {
        writeProfiles([
            { id: -1, name: '$rsprofile' },
            { id, name, active: true }
        ]);
        if (content !== undefined) fs.writeFileSync(profileFile(name, id), content);
        return profileFile(name, id);
    }

    const read = (file) => fs.readFileSync(file, 'utf8');

    test('absent keys are written as false and the rest of the file is kept byte for byte', async () => {
        const original = `# header\r\nfoo.bar=1\r\n${SECRET_LINE}\r\nrunelite.somethingelse=true\r\n`;
        const file = setup({ content: original });
        const result = await policy().apply({ profileName: 'main' });
        expect(result).toEqual({ status: 'applied', profiles: ['7'] });
        const after = fs.readFileSync(file);
        expect(after.subarray(0, Buffer.byteLength(original)).toString()).toBe(original);
        const keys = propertyKeys(after.toString());
        for (const key of POLICY_KEYS) expect(keys.has(key)).toBe(true);
        expect(read(file)).toContain('runelite.xptrackerplugin=false\r\n');
        expect(read(file)).toContain(SECRET_LINE);
    });

    test('a present true is never touched', async () => {
        const original = POLICY_KEYS.map((k) => `${k}=true`).join('\n') + '\n';
        const file = setup({ content: original });
        expect(await policy().apply({ profileName: 'main' })).toEqual({
            status: 'unchanged',
            profiles: []
        });
        expect(read(file)).toBe(original);
    });

    test('a present false is never touched', async () => {
        const original = POLICY_KEYS.map((k) => `${k}=false`).join('\n') + '\n';
        const file = setup({ content: original });
        await policy().apply({ profileName: 'main' });
        expect(read(file)).toBe(original);
    });

    test('mixed: only the absent keys are added, in the file LF style', async () => {
        const original = 'runelite.xptrackerplugin=true\nother=1\n';
        const file = setup({ content: original });
        await policy().apply({ profileName: 'main' });
        const text = read(file);
        expect(text.startsWith(original)).toBe(true);
        expect(text).toContain('runelite.chatcommandsplugin=false\n');
        expect(text).toContain('runelite.crowdsourcingplugin=false\n');
        expect(text).not.toContain('\r');
        expect(text.match(/runelite\.xptrackerplugin/g)).toHaveLength(1);
        expect(text).toContain('runelite.xptrackerplugin=true');
    });

    test('a file without a trailing newline gets one before the additions', async () => {
        const file = setup({ content: 'a=1' });
        await policy().apply({ profileName: 'main' });
        expect(read(file).startsWith('a=1\n') || read(file).startsWith('a=1\r\n')).toBe(true);
    });

    test('a profile file that does not exist is not created and no marker is written', async () => {
        setup();
        const result = await policy().apply({ profileName: 'main' });
        expect(result.status).toBe('unchanged');
        expect(fs.existsSync(profileFile('main', 7))).toBe(false);
        expect(fs.existsSync(path.join(productDataDir, MARKER_FILE))).toBe(false);
    });

    test('no profile index at all is a no-op', async () => {
        expect(await policy().apply({ profileName: 'main' })).toEqual({ status: 'none', profiles: [] });
    });

    test('the internal profile and other names are not touched when a profile is named', async () => {
        writeProfiles([
            { id: -1, name: '$rsprofile' },
            { id: 7, name: 'main' },
            { id: 8, name: 'other' }
        ]);
        fs.writeFileSync(profileFile('main', 7), 'a=1\n');
        fs.writeFileSync(profileFile('other', 8), 'b=2\n');
        fs.writeFileSync(path.join(profilesDir, '$rsprofile--1.properties'), 'rs=1\n');
        await policy().apply({ profileName: 'main' });
        expect(read(profileFile('other', 8))).toBe('b=2\n');
        expect(read(path.join(profilesDir, '$rsprofile--1.properties'))).toBe('rs=1\n');
        expect(read(profileFile('main', 7))).toContain('runelite.xptrackerplugin=false');
    });

    test('without a profile name every non-internal profile is covered', async () => {
        writeProfiles([
            { id: -1, name: '$rsprofile' },
            { id: 7, name: 'main' },
            { id: 8, name: 'other' }
        ]);
        fs.writeFileSync(profileFile('main', 7), 'a=1\n');
        fs.writeFileSync(profileFile('other', 8), 'b=2\n');
        const result = await policy().apply({ profileName: null });
        expect(result.profiles.sort()).toEqual(['7', '8']);
    });

    test('the second run changes nothing, and a later removal by the user is respected', async () => {
        const file = setup({ content: 'a=1\n' });
        await policy().apply({ profileName: 'main' });
        const afterFirst = sha(file);
        expect((await policy().apply({ profileName: 'main' })).status).toBe('unchanged');
        expect(sha(file)).toBe(afterFirst);
        // The user turns a plugin on (explicit true) and later removes the keys: no second override.
        fs.writeFileSync(file, 'a=1\n');
        expect((await policy().apply({ profileName: 'main' })).status).toBe('unchanged');
        expect(read(file)).toBe('a=1\n');
    });

    test('a plugin the user turns on after the policy stays on', async () => {
        const file = setup({ content: 'a=1\n' });
        await policy().apply({ profileName: 'main' });
        fs.writeFileSync(file, read(file).replace('runelite.xptrackerplugin=false', 'runelite.xptrackerplugin=true'));
        await policy().apply({ profileName: 'main' });
        expect(read(file)).toContain('runelite.xptrackerplugin=true');
    });

    test('the marker records profile ids and times only', async () => {
        setup({ content: `${SECRET_LINE}\n` });
        await policy().apply({ profileName: 'main' });
        const markerText = read(path.join(productDataDir, MARKER_FILE));
        expect(markerText).not.toContain('SECRET');
        expect(markerText).not.toContain('ENCRYPTED-PASSWORD');
        expect(JSON.parse(markerText).profiles['7'].policy).toBe(1);
    });

    describe('fails safe', () => {
        test('a locked profile directory stops the launch and the file is untouched', async () => {
            const file = setup({ content: 'a=1\n' });
            const sleeps = [];
            await expect(
                policy({
                    probeLock: () => true,
                    lockAttempts: 3,
                    sleep: async (ms) => sleeps.push(ms)
                }).apply({ profileName: 'main' })
            ).rejects.toBeInstanceOf(PrivacyPolicyError);
            expect(read(file)).toBe('a=1\n');
            expect(sleeps).toHaveLength(3);
            expect(fs.existsSync(path.join(productDataDir, MARKER_FILE))).toBe(false);
        });

        test('a lock that clears in time lets the policy apply', async () => {
            const file = setup({ content: 'a=1\n' });
            let calls = 0;
            await policy({ probeLock: () => ++calls < 3 }).apply({ profileName: 'main' });
            expect(read(file)).toContain('runelite.xptrackerplugin=false');
        });

        test('a locked directory does not matter when the policy was already applied', async () => {
            setup({ content: 'a=1\n' });
            await policy().apply({ profileName: 'main' });
            await expect(
                policy({ probeLock: () => true }).apply({ profileName: 'main' })
            ).resolves.toMatchObject({ status: 'unchanged' });
        });

        test('a malformed (binary) file is left unchanged and stops the launch', async () => {
            const file = profileFile('main', 7);
            setup();
            const bytes = Buffer.from([0x61, 0x3d, 0x00, 0x01, 0x0a]);
            fs.writeFileSync(file, bytes);
            await expect(policy().apply({ profileName: 'main' })).rejects.toBeInstanceOf(
                PrivacyPolicyError
            );
            expect(fs.readFileSync(file).equals(bytes)).toBe(true);
            expect(fs.readdirSync(profilesDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
        });

        test('a file that ends inside a continued line is left unchanged', async () => {
            const file = setup({ content: 'a=1\nb=two \\\n' });
            await expect(policy().apply({ profileName: 'main' })).rejects.toBeInstanceOf(
                PrivacyPolicyError
            );
            expect(read(file)).toBe('a=1\nb=two \\\n');
        });

        test('a failing rename leaves the original and removes the temporary file', async () => {
            const file = setup({ content: 'a=1\n' });
            const failingFs = Object.create(fs);
            failingFs.renameSync = () => {
                throw Object.assign(new Error('busy'), { code: 'EBUSY' });
            };
            await expect(policy({ fs: failingFs }).apply({ profileName: 'main' })).rejects.toBeInstanceOf(
                PrivacyPolicyError
            );
            expect(read(file)).toBe('a=1\n');
            expect(fs.readdirSync(profilesDir).filter((n) => n.includes('policy-'))).toEqual([]);
        });

        test('a file that changes while it is being updated is not replaced', async () => {
            const file = setup({ content: 'a=1\n' });
            const racingFs = Object.create(fs);
            racingFs.renameSync = fs.renameSync;
            let statCalls = 0;
            racingFs.statSync = (target, ...rest) => {
                const stat = fs.statSync(target, ...rest);
                if (target === file && ++statCalls === 2) {
                    return { ...stat, size: stat.size + 1, mtimeMs: stat.mtimeMs + 1 };
                }
                return stat;
            };
            await expect(policy({ fs: racingFs }).apply({ profileName: 'main' })).rejects.toBeInstanceOf(
                PrivacyPolicyError
            );
            expect(read(file)).toBe('a=1\n');
        });

        test('a profile name that would escape the profile directory stops the launch', async () => {
            writeProfiles([{ id: 9, name: '..\\..\\evil' }]);
            await expect(policy().apply({ profileName: null })).rejects.toBeInstanceOf(
                PrivacyPolicyError
            );
        });
    });

    test('nothing outside microbot-profiles and the marker is ever written; official files are untouched', async () => {
        setup({ content: 'a=1\n' });
        const official = {
            profiles2: path.join(runeliteDir, 'profiles2'),
            settings: path.join(runeliteDir, 'settings.properties'),
            credentials: path.join(runeliteDir, 'credentials.properties')
        };
        fs.mkdirSync(official.profiles2);
        fs.writeFileSync(path.join(official.profiles2, 'default-1.properties'), 'x=1\n');
        fs.writeFileSync(official.settings, 'runelite.xptrackerplugin=true\n');
        fs.writeFileSync(official.credentials, 'JX_SESSION_ID=official\n');
        const before = {
            settings: sha(official.settings),
            credentials: sha(official.credentials),
            profiles2: sha(path.join(official.profiles2, 'default-1.properties')),
            mtimes: [official.settings, official.credentials].map((f) => fs.statSync(f).mtimeMs)
        };

        const guard = guardDirectory(fs, runeliteDir, { allow: [profilesDir] });
        await policy({ fs: guard.fs }).apply({ profileName: 'main' });

        expect(guard.violations).toEqual([]);
        expect(sha(official.settings)).toBe(before.settings);
        expect(sha(official.credentials)).toBe(before.credentials);
        expect(sha(path.join(official.profiles2, 'default-1.properties'))).toBe(before.profiles2);
        expect([official.settings, official.credentials].map((f) => fs.statSync(f).mtimeMs)).toEqual(
            before.mtimes
        );
    });
});

describe('the policy gates the client start', () => {
    let harness;

    beforeEach(() => {
        jest.resetModules();
        delete process.env.DEBUG;
    });

    afterEach(() => harness?.cleanup());

    test('open-client applies the policy for the account profile before spawning', async () => {
        const apply = jest.fn().mockResolvedValue({ status: 'applied', profiles: ['7'] });
        harness = createFakeLaunchHarness({ extraDeps: { profilePrivacyPolicy: { apply } } });
        harness.launchAccount.profile = 'alt';
        await require('../libs/jar-executor')(harness.deps);
        const result = await harness.handlers['open-client']({}, '9.9.9', null, 'test-account', '');
        expect(result).toEqual({ success: true });
        expect(apply).toHaveBeenCalledWith({ profileName: 'alt' });
        await harness.waitForClientSpawn();
    });

    test('open-client does not start the client when the policy fails', async () => {
        const apply = jest.fn().mockRejectedValue(new PrivacyPolicyError('profiles are in use'));
        harness = createFakeLaunchHarness({ extraDeps: { profilePrivacyPolicy: { apply } } });
        await require('../libs/jar-executor')(harness.deps);
        const result = await harness.handlers['open-client']({}, '9.9.9', null, 'test-account', '');
        expect(result).toEqual({ error: 'profiles are in use' });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(harness.spawnCalls).toEqual([]);
        expect(harness.deps.productSessionService.createClientTicket).not.toHaveBeenCalled();
    });

    test('play-no-jagex-account does not start the client when the policy fails', async () => {
        const apply = jest.fn().mockRejectedValue(new PrivacyPolicyError('profiles are in use'));
        harness = createFakeLaunchHarness({ extraDeps: { profilePrivacyPolicy: { apply } } });
        await require('../libs/jar-executor')(harness.deps);
        const result = await harness.handlers['play-no-jagex-account']({}, '9.9.9', null, '');
        expect(result).toEqual({ error: 'profiles are in use' });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(harness.spawnCalls).toEqual([]);
    });

    test('play-no-jagex-account applies the policy with no profile name when none is preferred', async () => {
        const apply = jest.fn().mockResolvedValue({ status: 'none', profiles: [] });
        harness = createFakeLaunchHarness({ extraDeps: { profilePrivacyPolicy: { apply } } });
        await require('../libs/jar-executor')(harness.deps);
        await harness.handlers['play-no-jagex-account']({}, '9.9.9', null, '');
        expect(apply).toHaveBeenCalledWith({ profileName: null });
    });
});
