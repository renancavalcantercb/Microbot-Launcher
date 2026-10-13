const {
    LauncherTooOldError,
    assertLauncherSupportsClient,
    compareVersions
} = require('../libs/launcher-compatibility');

describe('compareVersions', () => {
    test.each([
        ['3.2.11', '3.2.12', -1],
        ['3.2.12', '3.2.11', 1],
        ['3.2.12', '3.2.12', 0],
        ['3.10.0', '3.9.9', 1],
        ['4.0.0', '3.99.99', 1],
        ['3.2.9', '3.2.10', -1]
    ])('%s vs %s', (a, b, expected) => {
        expect(compareVersions(a, b)).toBe(expected);
    });
});

describe('assertLauncherSupportsClient', () => {
    const client = (minimumLauncherVersion) => ({ minimumLauncherVersion });

    test('passes when the launcher is at or above the minimum', () => {
        expect(() => assertLauncherSupportsClient({ launcherVersion: '3.2.12', client: client('3.2.10') })).not.toThrow();
        expect(() => assertLauncherSupportsClient({ launcherVersion: '3.2.12', client: client('3.2.12') })).not.toThrow();
    });

    test('refuses a launcher below the minimum with an update message', () => {
        let caught;
        try {
            assertLauncherSupportsClient({ launcherVersion: '3.2.11', client: client('3.2.12') });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(LauncherTooOldError);
        expect(caught.message).toContain('3.2.12 or newer');
        expect(caught.message).toContain('Install the latest launcher');
        expect(caught).toMatchObject({ required: '3.2.12', current: '3.2.11' });
    });

    test.each([
        ['a missing minimum', undefined, '3.2.12'],
        ['a malformed minimum', '3.2', '3.2.12'],
        ['a prerelease launcher version', '3.2.10', '3.2.12-test'],
        ['a missing launcher version', '3.2.10', undefined]
    ])('never passes by default with %s', (_label, minimum, launcher) => {
        expect(() => assertLauncherSupportsClient({ launcherVersion: launcher, client: client(minimum) })).toThrow();
    });

    test('the manifests published so far (minimum 3.2.10) are accepted by 3.2.11 and 3.2.12', () => {
        for (const launcherVersion of ['3.2.11', '3.2.12']) {
            expect(() => assertLauncherSupportsClient({ launcherVersion, client: client('3.2.10') })).not.toThrow();
        }
    });
});
