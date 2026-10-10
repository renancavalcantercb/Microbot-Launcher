const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClientTicketBroker } = require('../libs/client-ticket-broker');

function request(url, capability) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = http.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'POST',
            headers: capability ? { Authorization: `Bearer ${capability}` } : {}
        }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
        });
        req.on('error', reject);
        req.end();
    });
}

describe('ClientTicketBroker', () => {
    let broker;
    let temporaryDirectories = [];
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const ticket = {
        tokenType: 'Bearer',
        ticket: 'header.payload.signature',
        expiresAt: '2026-10-09T20:00:00.000Z',
        keyId: 'staging-2026-01',
        audience: 'microbot-cut-client',
        apiBaseUrl: 'https://cut-staging.xulixnacc.online'
    };

    afterEach(() => {
        broker?.close();
        for (const directory of temporaryDirectories) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
        temporaryDirectories = [];
    });

    function createSecretStore() {
        return {
            isAvailable: () => true,
            protect: (value) => ({ protection: 'test', value: Buffer.from(value).toString('base64') }),
            reveal: (value) => Buffer.from(value.value, 'base64').toString('utf8')
        };
    }

    test('binds to loopback and returns a ticket only for the child capability', async () => {
        const productSessionService = {
            createClientTicket: jest.fn().mockResolvedValue(ticket)
        };
        broker = new ClientTicketBroker({ productSessionService, log });
        const grant = await broker.createGrant();
        const url = grant.environment.MICROBOT_CUT_AUTH_BROKER_URL;
        const capability = grant.environment.MICROBOT_CUT_AUTH_BROKER_CAPABILITY;

        expect(new URL(url).hostname).toBe('127.0.0.1');
        expect((await request(url)).status).toBe(401);
        expect(await request(url, capability)).toEqual({ status: 200, body: ticket });
        expect(productSessionService.createClientTicket).toHaveBeenCalledTimes(1);

        grant.release();
        expect((await request(url, capability)).status).toBe(401);
    });

    test('accepts an authenticated health acknowledgement for its release grant', async () => {
        const onClientHealthy = jest.fn();
        broker = new ClientTicketBroker({
            productSessionService: { createClientTicket: jest.fn() },
            log,
            onClientHealthy
        });
        const grant = await broker.createGrant({ releaseVersion: 'cut-2.6.30-p16' });
        const healthUrl = grant.environment.MICROBOT_CUT_HEALTH_BROKER_URL;
        const capability = grant.environment.MICROBOT_CUT_AUTH_BROKER_CAPABILITY;

        expect((await request(healthUrl)).status).toBe(401);
        expect(await request(healthUrl, capability)).toEqual({
            status: 200,
            body: { status: 'accepted' }
        });
        expect(onClientHealthy).toHaveBeenCalledWith({
            releaseVersion: 'cut-2.6.30-p16',
            capability
        });
    });

    test('preserves revocation and transient failure semantics', async () => {
        const revoked = Object.assign(new Error('revoked'), { response: { status: 401 } });
        const productSessionService = {
            createClientTicket: jest.fn()
                .mockRejectedValueOnce(revoked)
                .mockRejectedValueOnce(new Error('network down'))
        };
        broker = new ClientTicketBroker({ productSessionService, log });
        const grant = await broker.createGrant();
        const url = grant.environment.MICROBOT_CUT_AUTH_BROKER_URL;
        const capability = grant.environment.MICROBOT_CUT_AUTH_BROKER_CAPABILITY;

        expect((await request(url, capability)).status).toBe(401);
        expect((await request(url, capability)).status).toBe(503);
    });

    test('restores an existing client grant after launcher restart and republishes discovery', async () => {
        const productDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'microbot-cut-broker-'));
        temporaryDirectories.push(productDataDir);
        const secretStore = createSecretStore();
        const firstService = { createClientTicket: jest.fn().mockResolvedValue(ticket) };
        broker = new ClientTicketBroker({
            productSessionService: firstService,
            log,
            productDataDir,
            secretStore
        });
        const grant = await broker.createGrant();
        const capability = grant.environment.MICROBOT_CUT_AUTH_BROKER_CAPABILITY;
        const discoveryFile = grant.environment.MICROBOT_CUT_AUTH_BROKER_DISCOVERY_FILE;

        expect(path.isAbsolute(discoveryFile)).toBe(true);
        const firstDiscovery = fs.readFileSync(discoveryFile, 'utf8');
        expect(firstDiscovery).not.toContain(capability);
        broker.close();

        const secondService = { createClientTicket: jest.fn().mockResolvedValue(ticket) };
        broker = new ClientTicketBroker({
            productSessionService: secondService,
            log,
            productDataDir,
            secretStore
        });
        await broker.ensureStarted();
        const discovery = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));

        expect(discovery.version).toBe(1);
        expect(discovery.url).not.toBe(grant.environment.MICROBOT_CUT_AUTH_BROKER_URL);
        expect((await request(discovery.url, capability)).status).toBe(200);
        expect(secondService.createClientTicket).toHaveBeenCalledTimes(1);
    });
});
