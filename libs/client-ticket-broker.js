const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

const LOOPBACK_HOST = '127.0.0.1';
const TICKET_PATH = '/v1/client-ticket';
const HEALTH_PATH = '/v1/client-health';
const DISCOVERY_FILE_NAME = 'client-ticket-broker.json';
const GRANTS_FILE_NAME = 'client-ticket-broker-grants.json';
const GRANT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

class ClientTicketBroker {
    constructor({
        productSessionService,
        log,
        httpModule = http,
        cryptoModule = crypto,
        fsModule = fs,
        pathModule = path,
        productDataDir = null,
        secretStore = null,
        now = () => Date.now(),
        onClientHealthy = () => {}
    }) {
        this.productSessionService = productSessionService;
        this.log = log;
        this.http = httpModule;
        this.crypto = cryptoModule;
        this.fs = fsModule;
        this.path = pathModule;
        this.productDataDir = productDataDir;
        this.secretStore = secretStore;
        this.now = now;
        this.onClientHealthy = onClientHealthy;
        this.server = null;
        this.port = null;
        this.grants = new Map();
        this.grantsLoaded = false;
        this.discoveryFile = productDataDir
            ? this.path.join(productDataDir, DISCOVERY_FILE_NAME)
            : null;
        this.grantsFile = productDataDir
            ? this.path.join(productDataDir, GRANTS_FILE_NAME)
            : null;
    }

    async createGrant({ releaseVersion = null } = {}) {
        if (!this.productSessionService) {
            throw new Error('Product session service is unavailable');
        }
        await this.ensureStarted();
        const capability = this.crypto.randomBytes(32).toString('base64url');
        this.grants.set(capability, {
            expiresAt: this.now() + GRANT_LIFETIME_MS,
            releaseVersion
        });
        this.persistGrants();
        let released = false;

        return {
            environment: {
                MICROBOT_CUT_AUTH_BROKER_URL: `http://${LOOPBACK_HOST}:${this.port}${TICKET_PATH}`,
                MICROBOT_CUT_HEALTH_BROKER_URL: `http://${LOOPBACK_HOST}:${this.port}${HEALTH_PATH}`,
                MICROBOT_CUT_AUTH_BROKER_CAPABILITY: capability,
                ...(this.discoveryFile
                    ? { MICROBOT_CUT_AUTH_BROKER_DISCOVERY_FILE: this.discoveryFile }
                    : {})
            },
            secrets: [capability],
            release: () => {
                if (released) return;
                released = true;
                this.grants.delete(capability);
                this.persistGrants();
            }
        };
    }

    async ensureStarted() {
        if (this.server) return;
        this.loadGrants();

        const server = this.http.createServer((request, response) => {
            this.handle(request, response).catch((error) => {
                this.log.error(`Client ticket broker failed: ${this.safeErrorMessage(error)}`);
                if (!response.headersSent) this.sendJson(response, 503, { error: 'temporarily_unavailable' });
                else response.destroy();
            });
        });

        await new Promise((resolve, reject) => {
            const onError = (error) => {
                server.removeListener('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                server.removeListener('error', onError);
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(0, LOOPBACK_HOST);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            server.close();
            throw new Error('Client ticket broker did not bind to a TCP port');
        }
        this.server = server;
        this.port = address.port;
        this.writeDiscoveryFile();
        this.log.info(`Client ticket broker listening on ${LOOPBACK_HOST}:${this.port}`);
    }

    async handle(request, response) {
        const remoteAddress = request.socket?.remoteAddress;
        if (remoteAddress !== LOOPBACK_HOST && remoteAddress !== '::1' && remoteAddress !== '::ffff:127.0.0.1') {
            return this.sendJson(response, 403, { error: 'forbidden' });
        }
        if (request.method !== 'POST' || ![TICKET_PATH, HEALTH_PATH].includes(request.url)) {
            return this.sendJson(response, 404, { error: 'not_found' });
        }

        const authorization = request.headers.authorization;
        const capability = typeof authorization === 'string' && authorization.startsWith('Bearer ')
            ? authorization.slice('Bearer '.length)
            : '';
        const grant = this.grants.get(capability);
        if (!capability || !grant || grant.expiresAt <= this.now()) {
            if (capability && grant) {
                this.grants.delete(capability);
                this.persistGrants();
            }
            return this.sendJson(response, 401, { error: 'unauthorized' });
        }

        if (request.url === HEALTH_PATH) {
            if (!grant.releaseVersion) {
                return this.sendJson(response, 400, { error: 'release_unknown' });
            }
            await this.onClientHealthy({
                releaseVersion: grant.releaseVersion,
                capability
            });
            return this.sendJson(response, 200, { status: 'accepted' });
        }

        try {
            const ticket = await this.productSessionService.createClientTicket();
            return this.sendJson(response, 200, ticket);
        } catch (error) {
            const status = error.response?.status || error.status;
            if (status === 401 || status === 403) {
                return this.sendJson(response, status, {
                    error: status === 401 ? 'session_revoked' : 'access_denied'
                });
            }
            this.log.warn(`Client ticket renewal failed: ${this.safeErrorMessage(error)}`);
            return this.sendJson(response, 503, { error: 'temporarily_unavailable' });
        }
    }

    sendJson(response, statusCode, body) {
        const payload = JSON.stringify(body);
        response.writeHead(statusCode, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': Buffer.byteLength(payload)
        });
        response.end(payload);
    }

    close() {
        if (!this.server) return;
        this.removeOwnDiscoveryFile();
        this.server.close();
        this.server = null;
        this.port = null;
    }

    loadGrants() {
        if (this.grantsLoaded) return;
        this.grantsLoaded = true;
        if (!this.canPersistSecrets() || !this.fs.existsSync(this.grantsFile)) return;

        try {
            const document = JSON.parse(this.fs.readFileSync(this.grantsFile, 'utf8'));
            const payload = JSON.parse(this.secretStore.reveal(document.payload));
            if (![1, 2].includes(document.version) || ![1, 2].includes(payload.version) || !Array.isArray(payload.grants)) {
                throw new Error('Unsupported broker grant document');
            }
            const now = this.now();
            for (const grant of payload.grants) {
                if (
                    grant &&
                    typeof grant.capability === 'string' &&
                    /^[A-Za-z0-9_-]{32,128}$/.test(grant.capability) &&
                    Number.isSafeInteger(grant.expiresAt) &&
                    grant.expiresAt > now
                ) {
                    this.grants.set(grant.capability, {
                        expiresAt: grant.expiresAt,
                        releaseVersion:
                            typeof grant.releaseVersion === 'string'
                                ? grant.releaseVersion
                                : null
                    });
                }
            }
            this.persistGrants();
        } catch (error) {
            this.log.warn(`Failed to restore client broker grants: ${this.safeErrorMessage(error)}`);
        }
    }

    persistGrants() {
        if (!this.canPersistSecrets()) return;
        try {
            this.fs.mkdirSync(this.productDataDir, { recursive: true });
            const now = this.now();
            const grants = [];
            for (const [capability, grant] of this.grants.entries()) {
                if (grant.expiresAt > now) grants.push({ capability, ...grant });
                else this.grants.delete(capability);
            }
            const protectedPayload = this.secretStore.protect(JSON.stringify({
                version: 2,
                grants
            }));
            this.writeJsonAtomically(this.grantsFile, {
                version: 2,
                payload: protectedPayload
            });
        } catch (error) {
            this.log.warn(`Failed to persist client broker grants: ${this.safeErrorMessage(error)}`);
        }
    }

    canPersistSecrets() {
        return Boolean(
            this.grantsFile &&
            this.secretStore &&
            typeof this.secretStore.isAvailable === 'function' &&
            this.secretStore.isAvailable() &&
            typeof this.secretStore.protect === 'function' &&
            typeof this.secretStore.reveal === 'function'
        );
    }

    writeDiscoveryFile() {
        if (!this.discoveryFile) return;
        try {
            this.fs.mkdirSync(this.productDataDir, { recursive: true });
            this.writeJsonAtomically(this.discoveryFile, {
                version: 1,
                url: `http://${LOOPBACK_HOST}:${this.port}${TICKET_PATH}`,
                updatedAt: new Date(this.now()).toISOString()
            });
        } catch (error) {
            this.log.warn(`Failed to publish client broker discovery: ${this.safeErrorMessage(error)}`);
        }
    }

    removeOwnDiscoveryFile() {
        if (!this.discoveryFile || !this.fs.existsSync(this.discoveryFile)) return;
        try {
            const document = JSON.parse(this.fs.readFileSync(this.discoveryFile, 'utf8'));
            const ownUrl = `http://${LOOPBACK_HOST}:${this.port}${TICKET_PATH}`;
            if (document.url === ownUrl) this.fs.unlinkSync(this.discoveryFile);
        } catch (_) {
            // A newer launcher may be replacing the discovery file. Leave it alone.
        }
    }

    writeJsonAtomically(target, value) {
        const temporary = `${target}.${process.pid}.${this.crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
            this.fs.writeFileSync(temporary, JSON.stringify(value, null, 2), {
                encoding: 'utf8',
                mode: 0o600
            });
            if (this.fs.existsSync(target)) this.fs.unlinkSync(target);
            this.fs.renameSync(temporary, target);
        } finally {
            if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary);
        }
    }

    safeErrorMessage(error) {
        return error instanceof Error ? error.message : 'Unknown error';
    }
}

module.exports = {
    ClientTicketBroker,
    LOOPBACK_HOST,
    TICKET_PATH,
    HEALTH_PATH,
    DISCOVERY_FILE_NAME,
    GRANTS_FILE_NAME,
    GRANT_LIFETIME_MS
};
