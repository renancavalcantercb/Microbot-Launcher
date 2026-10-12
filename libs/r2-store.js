const crypto = require('crypto');

// The publication CLIs talk to R2 through its S3-compatible API, because only that API offers
// conditional writes (If-Match / If-None-Match) and returns ETags. Wrangler offers neither: its
// `r2 object put` always overwrites and `r2 object get` reports no ETag.
//
// Signing (AWS Signature Version 4) is done here with `crypto` so the installer does not gain a
// dependency. Every request goes through one injected `fetch`, so tests never reach the network.
// Credentials come from the environment only and are never part of a message or a log line.

const REGION = 'auto';
const SERVICE = 's3';
const ENV_ACCOUNT = 'R2_ACCOUNT_ID';
const ENV_KEY_ID = 'R2_ACCESS_KEY_ID';
const ENV_SECRET = 'R2_SECRET_ACCESS_KEY';
const ENV_ENDPOINT = 'R2_S3_ENDPOINT';

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

// RFC 3986 unreserved characters stay, everything else is percent-encoded; S3 does not encode twice.
function encodeSegment(segment) {
    return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(pathname) {
    return pathname.split('/').map(encodeSegment).join('/');
}

function amzDateOf(date) {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

// Returns the headers that must be sent for this request, including Authorization. `headers` are the
// request headers other than the three x-amz-* ones and Host, which are added here.
function signRequest({
    method, host, path, headers = {}, payloadHash, accessKeyId, secretAccessKey, date,
    region = REGION, service = SERVICE
}) {
    const amzDate = amzDateOf(date);
    const day = amzDate.slice(0, 8);
    const all = {
        ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value).trim()])),
        host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate
    };
    const names = Object.keys(all).sort();
    const canonicalRequest = [
        method,
        encodePath(path),
        '',
        ...names.map((name) => `${name}:${all[name]}`),
        '',
        names.join(';'),
        payloadHash
    ].join('\n');
    const scope = `${day}/${region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
    const { host: _host, ...sent } = all;
    return {
        ...sent,
        Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`
    };
}

function credentialsFromEnvironment(config = {}, env = process.env) {
    const accountId = env[ENV_ACCOUNT] || config.r2AccountId || '';
    const accessKeyId = env[ENV_KEY_ID] || '';
    const secretAccessKey = env[ENV_SECRET] || '';
    const missing = [];
    if (!accountId && !env[ENV_ENDPOINT]) missing.push(ENV_ACCOUNT);
    if (!accessKeyId) missing.push(ENV_KEY_ID);
    if (!secretAccessKey) missing.push(ENV_SECRET);
    if (missing.length) {
        throw new Error(
            `R2 credentials are missing: set ${missing.join(', ')} in the environment of this shell ` +
            '(an R2 API token scoped to the channel bucket; the Wrangler login does not provide them)'
        );
    }
    return { accountId, accessKeyId, secretAccessKey, endpoint: env[ENV_ENDPOINT] || null };
}

class R2Error extends Error {
    constructor(message, { status = null, code = null } = {}) {
        super(message);
        this.name = 'R2Error';
        this.status = status;
        this.code = code;
    }
}

function xmlField(body, name) {
    const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(body || '');
    return match ? match[1] : null;
}

// `writable: false` builds a store that cannot write at all: the dry runs use it, so a bug in a dry
// run cannot reach R2 no matter what the credentials allow.
function createR2Store({
    bucket, accountId, accessKeyId, secretAccessKey, endpoint = null,
    fetch: send = (url, options) => fetch(url, { redirect: 'error', ...options }),
    now = () => new Date(), writable = true
}) {
    if (!bucket || !accessKeyId || !secretAccessKey || (!accountId && !endpoint)) {
        throw new Error('the R2 store needs a bucket and credentials');
    }
    const base = new URL(endpoint || `https://${accountId}.r2.cloudflarestorage.com`);
    const secrets = [accessKeyId, secretAccessKey];
    const clean = (text) => secrets.reduce((value, secret) => value.split(secret).join('***'), String(text));

    // Every request asks for the object as stored. Without this the R2 edge gzips the response and
    // weakens its ETag (`W/"..."`), which If-Match must never be given. Measured on the staging
    // bucket: HEAD and GET returned `W/"<md5>"` with content-encoding gzip, and
    // `accept-encoding: identity` returned the strong `"<md5>"`.
    async function request(method, key, { body = null, headers = {} } = {}) {
        const objectPath = `/${bucket}/${key}`;
        const payload = body || Buffer.alloc(0);
        const signed = signRequest({
            method,
            host: base.host,
            path: objectPath,
            headers: { 'Accept-Encoding': 'identity', ...headers },
            payloadHash: sha256Hex(payload),
            accessKeyId,
            secretAccessKey,
            date: now()
        });
        const url = `${base.origin}${encodePath(objectPath)}`;
        try {
            return await send(url, { method, headers: signed, body: body || undefined, cache: 'no-store' });
        } catch (error) {
            // A transport failure after a PUT was sent may or may not have been applied.
            throw new R2Error(`R2 ${method} ${key} did not complete: ${clean(error.message)}`);
        }
    }

    async function failure(method, key, response) {
        let detail = '';
        try {
            const text = await response.text();
            const code = xmlField(text, 'Code');
            const message = xmlField(text, 'Message');
            detail = [code, message].filter(Boolean).join(': ');
        } catch (_) {
            detail = '';
        }
        return new R2Error(
            `R2 ${method} ${key} failed with HTTP ${response.status}${detail ? ` (${clean(detail)})` : ''}`,
            { status: response.status }
        );
    }

    const etagOf = (response) => response.headers.get('etag');

    // A weak ETag can never be the base of an If-Match write. Refuse it where it is read, so it
    // cannot reach a bundle; the message names the cause.
    function strongEtagOf(method, key, response) {
        const etag = etagOf(response);
        if (typeof etag === 'string' && /^W\//i.test(etag)) {
            throw new R2Error(
                `R2 ${method} ${key} returned a weak ETag; refusing to use it as the base of a conditional write`
            );
        }
        return etag;
    }

    async function get(key) {
        const response = await request('GET', key);
        if (response.status === 404) return { found: false };
        if (!response.ok) throw await failure('GET', key, response);
        return { found: true, bytes: Buffer.from(await response.arrayBuffer()), etag: strongEtagOf('GET', key, response) };
    }

    async function head(key) {
        const response = await request('HEAD', key);
        if (response.status === 404) return { found: false };
        if (!response.ok) throw await failure('HEAD', key, response);
        return { found: true, size: Number(response.headers.get('content-length')), etag: strongEtagOf('HEAD', key, response) };
    }

    // 412 (PreconditionFailed) is documented by Cloudflare; 409 is what S3 returns for a conditional
    // write that races another one. Both mean "someone else got there first". A missing object under
    // If-Match is the same situation. Nothing here ever retries.
    async function conditionalPut(key, bytes, contentType, condition) {
        if (!writable) throw new R2Error(`this R2 store is read-only; refusing to write ${key}`);
        const response = await request('PUT', key, {
            body: bytes,
            headers: { 'Content-Type': contentType, ...condition }
        });
        if (response.ok) return { status: 'created', etag: etagOf(response) };
        if ([412, 409].includes(response.status) || (response.status === 404 && condition['If-Match'])) {
            return { status: 'conflict', httpStatus: response.status };
        }
        throw await failure('PUT', key, response);
    }

    return {
        bucket,
        writable,
        get,
        head,
        putIfAbsent: (key, bytes, contentType) => conditionalPut(key, bytes, contentType, { 'If-None-Match': '*' }),
        putIfMatch: (key, bytes, contentType, etag) => {
            if (!etag) throw new Error('putIfMatch needs the ETag the write is based on');
            if (/^W\//i.test(etag)) throw new Error('putIfMatch needs a strong ETag; a weak one (W/...) never matches');
            return conditionalPut(key, bytes, contentType, { 'If-Match': etag });
        }
    };
}

function openStore(config, { writable = true, fetch: send, now, env = process.env } = {}) {
    const credentials = credentialsFromEnvironment(config, env);
    return createR2Store({ bucket: config.bucket, ...credentials, writable, fetch: send, now });
}

module.exports = {
    R2Error,
    createR2Store,
    credentialsFromEnvironment,
    openStore,
    sha256Hex,
    signRequest
};
