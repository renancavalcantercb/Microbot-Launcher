const crypto = require('crypto');

// An in-memory R2 with the semantics the publication code relies on: ETags that follow the content
// (R2 reports the MD5 of a single-part object), If-None-Match: * and If-Match on writes, a conflict
// answered as 412 (or 409 when asked to), and hooks that let a test slip a competing write between
// a read and the write that follows it. It stands where the S3 transport stands, so the CLIs run
// their real code against it and nothing reaches the network.

const etagOf = (bytes) => `"${crypto.createHash('md5').update(bytes).digest('hex')}"`;

function createMemoryR2() {
    const objects = new Map();
    const log = [];
    const faults = [];

    const state = {
        log,
        // Called as hook(op, bucket, key) just before the operation is handled. A hook may write to
        // the bucket to model another publisher getting there first.
        before: null,
        // Called as hook(op, bucket, key) right after a write was applied, before it is answered.
        after: null,
        conflictStatus: 412,

        seed(bucket, key, bytes) {
            const buffer = Buffer.from(bytes);
            objects.set(`${bucket}/${key}`, { bytes: buffer, etag: etagOf(buffer) });
        },
        bytes(bucket, key) {
            const found = objects.get(`${bucket}/${key}`);
            return found ? found.bytes : null;
        },
        etag(bucket, key) {
            const found = objects.get(`${bucket}/${key}`);
            return found ? found.etag : null;
        },
        has: (bucket, key) => objects.has(`${bucket}/${key}`),
        delete: (bucket, key) => objects.delete(`${bucket}/${key}`),
        keys: (bucket) => [...objects.keys()].filter((full) => full.startsWith(`${bucket}/`)).map((full) => full.slice(bucket.length + 1)),
        writes: () => log.filter((entry) => ['putIfAbsent', 'putIfMatch'].includes(entry.op)),
        // Next matching operation throws instead of answering. With `apply: true` the write lands
        // first and the response is lost, which is the ambiguous case.
        failNext(op, matcher, { apply = false, message = 'connection reset' } = {}) {
            faults.push({ op, matcher, apply, message, kind: 'throw' });
        },
        // Next matching put is stored with other bytes than the ones sent, and reports success.
        corruptNext(matcher) {
            faults.push({ op: 'put', matcher, kind: 'corrupt' });
        },

        store(bucket, { writable = true } = {}) {
            const full = (key) => `${bucket}/${key}`;
            const takeFault = (op, key) => {
                const index = faults.findIndex((fault) => {
                    const opMatches = fault.op === op || (fault.op === 'put' && op.startsWith('put'));
                    const keyMatches = typeof fault.matcher === 'function' ? fault.matcher(key) : fault.matcher === key;
                    return opMatches && keyMatches;
                });
                return index === -1 ? null : faults.splice(index, 1)[0];
            };
            const enter = (op, key, extra = {}) => {
                log.push({ op, bucket, key, ...extra });
                if (state.before) state.before(op, bucket, key);
            };

            const write = (op, key, bytes, contentType, condition) => {
                if (!writable) throw new Error(`this R2 store is read-only; refusing to write ${key}`);
                enter(op, key, { contentType, condition });
                const fault = takeFault(op, key);
                if (fault && fault.kind === 'throw' && !fault.apply) throw new Error(fault.message);
                const current = objects.get(full(key));
                const allowed = condition.ifNoneMatch ? !current : Boolean(current) && current.etag === condition.ifMatch;
                if (!allowed) return { status: 'conflict', httpStatus: state.conflictStatus };
                const stored = fault && fault.kind === 'corrupt' ? Buffer.concat([bytes, Buffer.from('!')]) : Buffer.from(bytes);
                objects.set(full(key), { bytes: stored, etag: etagOf(stored) });
                if (state.after) state.after(op, bucket, key);
                if (fault && fault.kind === 'throw') throw new Error(fault.message);
                return { status: 'created', etag: etagOf(stored) };
            };

            return {
                bucket,
                writable,
                async get(key) {
                    enter('get', key);
                    const fault = takeFault('get', key);
                    if (fault) throw new Error(fault.message);
                    const found = objects.get(full(key));
                    return found ? { found: true, bytes: Buffer.from(found.bytes), etag: found.etag } : { found: false };
                },
                async head(key) {
                    enter('head', key);
                    const found = objects.get(full(key));
                    return found ? { found: true, size: found.bytes.length, etag: found.etag } : { found: false };
                },
                async putIfAbsent(key, bytes, contentType) {
                    return write('putIfAbsent', key, bytes, contentType, { ifNoneMatch: true });
                },
                async putIfMatch(key, bytes, contentType, etag) {
                    if (!etag) throw new Error('putIfMatch needs the ETag the write is based on');
                    return write('putIfMatch', key, bytes, contentType, { ifMatch: etag });
                }
            };
        }
    };
    return state;
}

// A `fetch` that answers the S3 requests of the real transport (libs/r2-store.js) from the memory
// bucket, so a test can run a CLI through the real signing and header code. Every request is kept.
function createMemoryFetch(memory) {
    const requests = [];
    const fetchMock = async (url, options = {}) => {
        const { pathname } = new URL(url);
        const [, bucket, ...rest] = pathname.split('/');
        const key = decodeURIComponent(rest.join('/'));
        const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
        requests.push({ method: options.method, bucket, key, headers, body: options.body });
        const store = memory.store(bucket);
        if (options.method === 'GET') {
            const found = await store.get(key);
            return found.found ? new Response(found.bytes, { status: 200, headers: { etag: found.etag } }) : new Response(null, { status: 404 });
        }
        if (options.method === 'HEAD') {
            const found = await store.head(key);
            return found.found
                ? new Response(null, { status: 200, headers: { etag: found.etag, 'content-length': String(found.size) } })
                : new Response(null, { status: 404 });
        }
        const bytes = Buffer.from(options.body || []);
        const outcome = headers['if-none-match'] === '*'
            ? await store.putIfAbsent(key, bytes, headers['content-type'])
            : await store.putIfMatch(key, bytes, headers['content-type'], headers['if-match']);
        return outcome.status === 'created'
            ? new Response(null, { status: 200, headers: { etag: outcome.etag } })
            : new Response(null, { status: outcome.httpStatus });
    };
    fetchMock.requests = requests;
    return fetchMock;
}

module.exports = { createMemoryFetch, createMemoryR2, etagOf };
