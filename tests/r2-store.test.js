const { R2Error, createR2Store, credentialsFromEnvironment, openStore, signRequest } = require('../libs/r2-store');

// Signing vectors. The first is the GET Object example of the AWS Signature Version 4 documentation
// (examplebucket, test.txt, Range: bytes=0-9). All three were reproduced with botocore 1.34.0, an
// independent implementation, so the hand-written signer is pinned against something it did not
// produce. The AWS example keys are public documentation values, not credentials.
const EXAMPLE_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const EXAMPLE_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const FIXED_DATE = new Date('2013-05-24T00:00:00Z');

describe('R2 S3 request signing', () => {
    test('reproduces the AWS documentation GET Object signature', () => {
        const signed = signRequest({
            method: 'GET',
            host: 'examplebucket.s3.amazonaws.com',
            path: '/test.txt',
            headers: { Range: 'bytes=0-9' },
            payloadHash: EMPTY_SHA256,
            accessKeyId: EXAMPLE_KEY_ID,
            secretAccessKey: EXAMPLE_SECRET,
            date: FIXED_DATE,
            region: 'us-east-1'
        });
        expect(signed.Authorization).toBe(
            'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
            'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
            'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
        );
    });

    test('matches botocore for an R2 GET (region auto, path style)', () => {
        const signed = signRequest({
            method: 'GET',
            host: 'acct123.r2.cloudflarestorage.com',
            path: '/bucket-staging/releases/staging/candidates/sequence-5-manifest.json',
            payloadHash: EMPTY_SHA256,
            accessKeyId: EXAMPLE_KEY_ID,
            secretAccessKey: EXAMPLE_SECRET,
            date: FIXED_DATE
        });
        expect(signed.Authorization).toContain('Credential=AKIAIOSFODNN7EXAMPLE/20130524/auto/s3/aws4_request');
        expect(signed.Authorization).toContain('Signature=4df3799bd9875f933e0c956fa1666f618bd422914752c1cfc977d85631044b9e');
    });

    test('matches botocore for a conditional R2 PUT', () => {
        const signed = signRequest({
            method: 'PUT',
            host: 'acct123.r2.cloudflarestorage.com',
            path: '/bucket-staging/releases/staging/manifest.json',
            headers: { 'Content-Type': 'application/json', 'If-Match': '"abc123"' },
            payloadHash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
            accessKeyId: EXAMPLE_KEY_ID,
            secretAccessKey: EXAMPLE_SECRET,
            date: FIXED_DATE
        });
        expect(signed.Authorization).toContain('SignedHeaders=content-type;host;if-match;x-amz-content-sha256;x-amz-date');
        expect(signed.Authorization).toContain('Signature=f9f03a95e8df9cadcf89039c72fad274282aa4c5222bb0c77ba3e42c0b5e804a');
    });
});

describe('R2 store', () => {
    const SECRET = 'S3CR3T-never-print-this-value';
    const KEY_ID = 'KEYID-never-print-this-either';
    const options = (fetchMock, extra = {}) => ({
        bucket: 'bucket-staging', accountId: 'acct123', accessKeyId: KEY_ID, secretAccessKey: SECRET,
        fetch: fetchMock, now: () => FIXED_DATE, ...extra
    });
    const reply = (status, { body = '', headers = {} } = {}) => new Response(body || null, { status, headers });

    test('writes a manifest only under If-Match and an immutable object only under If-None-Match: *', async () => {
        const fetchMock = jest.fn(async () => reply(200, { headers: { etag: '"new"' } }));
        const store = createR2Store(options(fetchMock));
        await expect(store.putIfMatch('releases/staging/manifest.json', Buffer.from('{}'), 'application/json', '"base"'))
            .resolves.toEqual({ status: 'created', etag: '"new"' });
        await store.putIfAbsent('releases/artifacts/x', Buffer.from('x'), 'application/octet-stream');

        const [manifestCall, artifactCall] = fetchMock.mock.calls;
        expect(manifestCall[0]).toBe('https://acct123.r2.cloudflarestorage.com/bucket-staging/releases/staging/manifest.json');
        expect(manifestCall[1].method).toBe('PUT');
        expect(manifestCall[1].headers['if-match']).toBe('"base"');
        expect(manifestCall[1].headers['if-none-match']).toBeUndefined();
        expect(artifactCall[1].headers['if-none-match']).toBe('*');
        expect(artifactCall[1].headers['if-match']).toBeUndefined();
        expect(manifestCall[1].headers.Authorization).toMatch(/SignedHeaders=accept-encoding;content-type;host;if-match;/);
        expect(artifactCall[1].headers.Authorization).toMatch(/SignedHeaders=accept-encoding;content-type;host;if-none-match;/);
    });

    test('there is no unconditional write', () => {
        const store = createR2Store(options(jest.fn()));
        expect(Object.keys(store).sort()).toEqual(['bucket', 'get', 'head', 'putIfAbsent', 'putIfMatch', 'writable']);
        expect(() => store.putIfMatch('k', Buffer.alloc(0), 'x', null)).toThrow(/ETag/);
    });

    test.each([[412], [409]])('HTTP %i on a conditional write is a conflict, reported once and never retried', async (status) => {
        const fetchMock = jest.fn(async () => reply(status));
        const store = createR2Store(options(fetchMock));
        await expect(store.putIfMatch('k', Buffer.from('x'), 'application/json', '"e"')).resolves.toEqual({ status: 'conflict', httpStatus: status });
        await expect(store.putIfAbsent('k', Buffer.from('x'), 'application/json')).resolves.toMatchObject({ status: 'conflict' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('a missing object under If-Match is a conflict too', async () => {
        const store = createR2Store(options(jest.fn(async () => reply(404))));
        await expect(store.putIfMatch('k', Buffer.from('x'), 'application/json', '"e"')).resolves.toMatchObject({ status: 'conflict' });
    });

    test('other statuses and transport errors are failures, not conflicts', async () => {
        const store = createR2Store(options(jest.fn(async () => reply(503, { body: '<Error><Code>InternalError</Code><Message>try later</Message></Error>' }))));
        await expect(store.putIfAbsent('k', Buffer.from('x'), 'x')).rejects.toThrow(/HTTP 503 \(InternalError: try later\)/);
        const broken = createR2Store(options(jest.fn(async () => { throw new Error('socket hang up'); })));
        await expect(broken.putIfAbsent('k', Buffer.from('x'), 'x')).rejects.toThrow(/did not complete: socket hang up/);
    });

    test('get and head report a missing key, the bytes and the ETag', async () => {
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(reply(404))
            .mockResolvedValueOnce(reply(200, { body: 'hello', headers: { etag: '"e1"' } }))
            .mockResolvedValueOnce(reply(200, { headers: { etag: '"e2"', 'content-length': '5' } }))
            .mockResolvedValueOnce(reply(403, { body: '<Error><Code>AccessDenied</Code></Error>' }));
        const store = createR2Store(options(fetchMock));
        await expect(store.get('k')).resolves.toEqual({ found: false });
        const found = await store.get('k');
        expect(found.bytes.toString()).toBe('hello');
        expect(found.etag).toBe('"e1"');
        await expect(store.head('k')).resolves.toEqual({ found: true, size: 5, etag: '"e2"' });
        await expect(store.get('k')).rejects.toThrow(/HTTP 403 \(AccessDenied\)/);
    });

    test('asks for the object as stored, so the edge does not gzip it and weaken its ETag', async () => {
        const fetchMock = jest.fn(async () => reply(200, { body: 'x', headers: { etag: '"e"' } }));
        const store = createR2Store(options(fetchMock));
        await store.get('k');
        await store.head('k');
        await store.putIfAbsent('k2', Buffer.from('x'), 'text/plain');
        for (const call of fetchMock.mock.calls) {
            expect(call[1].headers['accept-encoding']).toBe('identity');
            expect(call[1].headers.Authorization).toMatch(/SignedHeaders=accept-encoding;/);
        }
    });

    test('a weak ETag is refused where it is read and where it would be used', async () => {
        const fetchMock = jest.fn(async () => reply(200, { body: 'x', headers: { etag: 'W/"e"' } }));
        const store = createR2Store(options(fetchMock));
        await expect(store.get('k')).rejects.toThrow(/weak ETag/);
        await expect(store.head('k')).rejects.toThrow(/weak ETag/);
        expect(() => store.putIfMatch('k', Buffer.from('x'), 'text/plain', 'W/"e"')).toThrow(/strong ETag/);
        expect(fetchMock.mock.calls.every((call) => call[1].method !== 'PUT')).toBe(true);
    });

    test('a read-only store never sends a write', async () => {
        const fetchMock = jest.fn(async () => reply(200));
        const store = createR2Store(options(fetchMock, { writable: false }));
        await expect(store.putIfAbsent('k', Buffer.from('x'), 'x')).rejects.toThrow(/read-only/);
        await expect(store.putIfMatch('k', Buffer.from('x'), 'x', '"e"')).rejects.toThrow(/read-only/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('credentials never appear in an error, in a request URL or in a header value other than the signature scope', async () => {
        const leakingBody = `<Error><Code>SignatureDoesNotMatch</Code><Message>bad ${SECRET} for ${KEY_ID}</Message></Error>`;
        const fetchMock = jest.fn(async () => reply(403, { body: leakingBody }));
        const store = createR2Store(options(fetchMock));
        const failures = [];
        await store.get('k').catch((error) => failures.push(error.message));
        await store.putIfAbsent('k', Buffer.from('x'), 'x').catch((error) => failures.push(error.message));
        const broken = createR2Store(options(jest.fn(async () => { throw new Error(`connect failed for ${SECRET}`); })));
        await broken.head('k').catch((error) => failures.push(error.message));
        expect(failures).toHaveLength(3);
        for (const message of failures) {
            expect(message).not.toContain(SECRET);
            expect(message).not.toContain(KEY_ID);
        }
        for (const [url, request] of fetchMock.mock.calls) {
            expect(url).not.toContain(SECRET);
            expect(JSON.stringify(request.headers)).not.toContain(SECRET);
        }
    });

    describe('credentials', () => {
        test('are read from the environment and a missing one is named by variable, never by value', () => {
            expect(() => credentialsFromEnvironment({}, {})).toThrow(/R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/);
            expect(() => credentialsFromEnvironment({}, { R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b' })).toThrow(/set R2_SECRET_ACCESS_KEY in the environment/);
            expect(credentialsFromEnvironment({}, { R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c' }))
                .toMatchObject({ accountId: 'a', accessKeyId: 'b', secretAccessKey: 'c' });
        });

        test('the account ID may come from the configuration, the secrets only from the environment', () => {
            const env = { R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c' };
            expect(credentialsFromEnvironment({ r2AccountId: 'acct' }, env).accountId).toBe('acct');
            expect(() => credentialsFromEnvironment({ r2AccountId: 'acct', r2SecretAccessKey: 'nope' }, { R2_ACCESS_KEY_ID: 'b' })).toThrow(/R2_SECRET_ACCESS_KEY/);
        });

        test('openStore builds a store for the configured bucket', () => {
            const store = openStore({ bucket: 'bucket-x' }, { env: { R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c' }, fetch: jest.fn() });
            expect(store.bucket).toBe('bucket-x');
            expect(store.writable).toBe(true);
        });
    });

    test('R2Error carries the status', () => {
        expect(new R2Error('x', { status: 500 }).status).toBe(500);
    });
});
