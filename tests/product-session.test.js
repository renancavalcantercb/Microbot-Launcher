const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProductSessionService, resolveApiBaseUrl, sessionFileName } = require('../libs/product-session');

function secretStore() {
    return {
        isAvailable: () => true,
        protect: (value) => ({ protection: 'test', value: Buffer.from(value).toString('base64') }),
        reveal: (value) => Buffer.from(value.value, 'base64').toString('utf8')
    };
}

function sessionResponse() {
    return {
        tokenType: 'Bearer',
        accessToken: 'mbc_at_selector_123.secret_access_value_abcdefghijklmnopqrstuvwxyz',
        accessExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        refreshToken: 'mbc_rt_selector_123.secret_refresh_value_abcdefghijklmnopqrstuvwxyz',
        refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        device: { id: 'device-id', name: 'Test PC' }
    };
}

function createService(directory, axios, environment = {}, onSessionInvalidated) {
    return new ProductSessionService({
        axios,
        fs,
        path,
        productDataDir: directory,
        productConfig: {
            productApiBaseUrl: 'http://localhost:5173/api/v1',
            productApiEnvironmentVariable: 'MICROBOT_CUT_API_BASE_URL'
        },
        packageJson: { version: '3.2.10' },
        secretStore: secretStore(),
        installationIdentity: { getOrCreate: () => '123e4567-e89b-42d3-a456-426614174000' },
        log: { warn: jest.fn() },
        environment,
        onSessionInvalidated
    });
}

describe('product session service', () => {
    let directory;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'product-session-'));
    });

    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    test('accepts HTTPS and local HTTP only', () => {
        const config = { productApiBaseUrl: 'https://api.example.com/api/v1', productApiEnvironmentVariable: 'API' };
        expect(resolveApiBaseUrl(config, {})).toBe('https://api.example.com/api/v1');
        expect(() => resolveApiBaseUrl(config, { API: 'http://api.example.com' })).toThrow('HTTPS');
    });

    test('uses independent session files for local and remote APIs', () => {
        const config = {
            productApiBaseUrl: 'http://localhost:5173/api/v1',
            productApiEnvironmentVariable: 'MICROBOT_CUT_API_BASE_URL'
        };

        expect(sessionFileName(resolveApiBaseUrl(config, {}), config)).toBe('product-session.json');
        expect(sessionFileName('https://staging.example.com/api/v1', config))
            .toMatch(/^product-session-[a-f0-9]{12}\.json$/);
        expect(sessionFileName('https://production.example.com/api/v1', config))
            .not.toBe(sessionFileName('https://staging.example.com/api/v1', config));
    });

    test('activates and persists tokens only inside the protected payload', async () => {
        const response = sessionResponse();
        const axios = {
            post: jest.fn().mockResolvedValue({ data: response }),
            get: jest.fn().mockResolvedValue({ data: { device: response.device } })
        };
        const service = createService(directory, axios);

        const status = await service.activate('mbc_act_TEST-CAFE-ABCD-2345');
        const file = fs.readFileSync(path.join(directory, 'product-session.json'), 'utf8');

        expect(status).toMatchObject({ authenticated: true, device: response.device });
        expect(axios.post.mock.calls[0][1].installationId).toBe('123e4567-e89b-42d3-a456-426614174000');
        expect(file).not.toContain(response.accessToken);
        expect(file).not.toContain(response.refreshToken);
    });

    test('does not expose tokens through status and clears them on signout', async () => {
        const response = sessionResponse();
        const axios = {
            post: jest.fn().mockResolvedValue({ data: response }),
            get: jest.fn().mockResolvedValue({ data: {
                device: response.device,
                plan: { id: 'free', name: 'Free', deviceLimit: 1 },
				entitlements: ['client.access', 'plugin.cut-runtime-info'],
				releaseCohort: 'beta',
				allowedReleaseChannels: ['production', 'staging'],
				selectedReleaseChannel: 'staging'
            } })
        };
        const service = createService(directory, axios);
        await service.activate('mbc_act_TEST-CAFE-ABCD-2345');

        const status = await service.status();
        expect(status.accessToken).toBeUndefined();
        expect(status.refreshToken).toBeUndefined();
        expect(status.plan).toEqual({ id: 'free', name: 'Free', deviceLimit: 1 });
        expect(status.entitlements).toEqual(['client.access', 'plugin.cut-runtime-info']);
		expect(status.releaseCohort).toBe('beta');
		expect(status.allowedReleaseChannels).toEqual(['production', 'staging']);
		expect(status.selectedReleaseChannel).toBe('staging');

        await service.signout();
        expect(fs.existsSync(path.join(directory, 'product-session.json'))).toBe(false);
    });

	test('authorizes configured channels from the server-provided cohort only', async () => {
		const response = sessionResponse();
		const axios = {
			post: jest.fn().mockResolvedValue({ data: response }),
			get: jest.fn().mockResolvedValue({ data: {
				device: response.device,
				releaseCohort: 'beta',
				allowedReleaseChannels: ['production', 'staging']
			} })
		};
		const service = createService(directory, axios);
		await service.activate('mbc_act_TEST-CAFE-ABCD-2345');

		await expect(service.authorizeReleaseChannel('staging')).resolves.toMatchObject({
			authenticated: true,
			releaseCohort: 'beta'
		});
		await expect(service.authorizeReleaseChannel('internal'))
			.rejects.toThrow('beta release cohort cannot access the internal channel');
	});

	test('fails closed when the server omits release channel authorization', async () => {
		const response = sessionResponse();
		const axios = {
			post: jest.fn().mockResolvedValue({ data: response }),
			get: jest.fn().mockResolvedValue({ data: { device: response.device } })
		};
		const service = createService(directory, axios);
		await service.activate('mbc_act_TEST-CAFE-ABCD-2345');

		await expect(service.authorizeReleaseChannel('staging'))
			.rejects.toThrow('did not provide release channel access');
	});

    test('migrates a valid legacy session after remote API validation', async () => {
        const response = sessionResponse();
        const axios = {
            post: jest.fn().mockResolvedValue({ data: response }),
            get: jest.fn().mockResolvedValue({ data: { device: response.device } })
        };
        const localService = createService(directory, axios);
        await localService.activate('mbc_act_TEST-CAFE-ABCD-2345');

        const stagingService = createService(directory, axios, {
            MICROBOT_CUT_API_BASE_URL: 'https://staging.example.com/api/v1'
        });
        const status = await stagingService.status();

        expect(status.authenticated).toBe(true);
        expect(fs.existsSync(path.join(directory, 'product-session.json'))).toBe(false);
        expect(fs.existsSync(stagingService.filePath)).toBe(true);
    });

    test('signout removes only the current environment session', async () => {
        const response = sessionResponse();
        const axios = {
            post: jest.fn().mockResolvedValue({ data: response }),
            get: jest.fn().mockResolvedValue({ data: { device: response.device } })
        };
        const localService = createService(directory, axios);
        const stagingService = createService(directory, axios, {
            MICROBOT_CUT_API_BASE_URL: 'https://staging.example.com/api/v1'
        });
        await localService.activate('mbc_act_TEST-CAFE-ABCD-2345');
        await stagingService.activate('mbc_act_TEST-CAFE-ABCD-2345');

        await stagingService.signout();

        expect(fs.existsSync(localService.filePath)).toBe(true);
        expect(fs.existsSync(stagingService.filePath)).toBe(false);
    });

    test('issues a short client ticket without exposing the launcher refresh token', async () => {
        const response = sessionResponse();
        const ticket = 'header.payload.signature';
        const axios = {
            post: jest.fn()
                .mockResolvedValueOnce({ data: response })
                .mockResolvedValueOnce({ data: {
                    tokenType: 'Bearer',
                    ticket,
                    expiresAt: new Date(Date.now() + 3 * 60 * 1000).toISOString(),
                    keyId: 'staging-2026-01',
                    audience: 'microbot-cut-client'
                } }),
            get: jest.fn()
        };
        const service = createService(directory, axios);
        await service.activate('mbc_act_TEST-CAFE-ABCD-2345');

        const authorization = await service.createClientTicket();

        expect(authorization).toMatchObject({ ticket, keyId: 'staging-2026-01' });
        expect(axios.post.mock.calls[1][2].headers.Authorization).toBe(`Bearer ${response.accessToken}`);
        expect(JSON.stringify(authorization)).not.toContain(response.refreshToken);
    });

    test('clears the protected session and notifies the UI when ticket authorization is rejected', async () => {
        const response = sessionResponse();
        const unauthorized = Object.assign(new Error('Request failed'), {
            response: { status: 401 }
        });
        const axios = {
            post: jest.fn()
                .mockResolvedValueOnce({ data: response })
                .mockRejectedValueOnce(unauthorized),
            get: jest.fn()
        };
        const onSessionInvalidated = jest.fn();
        const service = createService(directory, axios, {}, onSessionInvalidated);
        await service.activate('mbc_act_TEST-CAFE-ABCD-2345');

        await expect(service.createClientTicket()).rejects.toBe(unauthorized);

        expect(fs.existsSync(service.filePath)).toBe(false);
        expect(onSessionInvalidated).toHaveBeenCalledWith({
            authenticated: false,
            error: 'Your session has expired or been revoked. Generate a new code.'
        });
    });

    test('coalesces concurrent refresh attempts so a rotating token is used only once', async () => {
        const expired = sessionResponse();
        expired.accessExpiresAt = new Date(Date.now() - 1000).toISOString();
        const refreshed = sessionResponse();
        refreshed.accessToken = 'mbc_at_selector_456.new_access_value_abcdefghijklmnopqrstuvwxyz';
        refreshed.refreshToken = 'mbc_rt_selector_456.new_refresh_value_abcdefghijklmnopqrstuvwxyz';
        let refreshCalls = 0;
        const axios = {
            post: jest.fn(async (url) => {
                if (url.endsWith('/launcher/activate')) return { data: expired };
                if (url.endsWith('/launcher/token/refresh')) {
                    refreshCalls += 1;
                    await new Promise((resolve) => setImmediate(resolve));
                    return { data: refreshed };
                }
                throw new Error(`Unexpected POST ${url}`);
            }),
            get: jest.fn().mockResolvedValue({ data: { device: refreshed.device } })
        };
        const service = createService(directory, axios);
        await service.activate('mbc_act_TEST-CAFE-ABCD-2345');

        const statuses = await Promise.all(Array.from({ length: 8 }, () => service.status()));

        expect(refreshCalls).toBe(1);
        expect(statuses.every((status) => status.authenticated)).toBe(true);
        expect(service.load().refreshToken).toBe(refreshed.refreshToken);
    });
});
