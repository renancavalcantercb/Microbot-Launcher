const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeHttpFailure } = require('../libs/http-failure');

describe('the launcher never works in the legacy directory', () => {
    let home;

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-iso-'));
        fs.mkdirSync(path.join(home, '.microbot'));
        fs.writeFileSync(path.join(home, '.microbot', 'accounts.json'), '[]');
        jest.resetModules();
        jest.doMock('os', () => ({ ...jest.requireActual('os'), homedir: () => home }));
    });

    afterEach(() => {
        jest.dontMock('os');
        fs.rmSync(home, { recursive: true, force: true });
    });

    test('the active directory is the product directory even when legacy data exists', () => {
        const dirModule = require('../libs/dir-module.js');
        expect(dirModule.legacyDataDir).toBe(path.join(home, '.microbot'));
        expect(dirModule.microbotDir).toBe(path.join(home, '.microbot-cut'));
        expect(dirModule.productDataDir).toBe(dirModule.microbotDir);
    });

    test('importing dir-module and resolving the layout writes nothing under the legacy directory', () => {
        const before = fs.readdirSync(path.join(home, '.microbot')).sort();
        require('../libs/dir-module.js');
        expect(fs.readdirSync(path.join(home, '.microbot')).sort()).toEqual(before);
        expect(fs.readFileSync(path.join(home, '.microbot', 'accounts.json'), 'utf8')).toBe('[]');
    });
});

describe('package identity that safeStorage depends on', () => {
    test('the internal package name stays microbot-launcher', () => {
        const pkg = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
        );
        // Renaming it makes every saved session undecryptable (BASELINE.md finding).
        expect(pkg.name).toBe('microbot-launcher');
    });
});

describe('OAuth failures are logged without response bodies (F4)', () => {
    test('status only, never the body', () => {
        const error = {
            message: 'Request failed',
            response: { status: 400, data: { error: 'invalid_grant', detail: 'SECRET-CODE-123' } }
        };
        const line = describeHttpFailure(error);
        expect(line).toBe('HTTP 400');
        expect(line).not.toContain('SECRET');
    });

    test('a string body is not logged either', () => {
        expect(
            describeHttpFailure({ response: { status: 500, data: 'token=abc' } })
        ).toBe('HTTP 500');
    });

    test('transport errors give the code only', () => {
        expect(describeHttpFailure({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND host' })).toBe(
            'no response (ENOTFOUND)'
        );
        expect(describeHttpFailure(new Error('x'))).toBe('no response');
        expect(describeHttpFailure(null)).toBe('no response');
    });

    test('oauth-jagex.js has no log call that interpolates a response body', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'libs', 'oauth-jagex.js'), 'utf8');
        const logCalls = source.match(/log\.(error|warn|info|debug)\([\s\S]*?\);/g) || [];
        expect(logCalls.length).toBeGreaterThan(0);
        for (const call of logCalls) {
            expect(call).not.toMatch(/response\??\.data/);
        }
    });
});
