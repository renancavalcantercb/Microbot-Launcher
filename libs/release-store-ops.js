const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { verifyReleaseManifest } = require('./release-manifest');

// The R2 operations both publication CLIs share. The client and the launcher write the same live
// manifest, so the way it is read, based on and replaced lives here once:
//
//  * `readLiveManifest` reads R2 itself (never the cached edge) and returns the bytes and the ETag.
//  * `prepare` records that ETag as the bundle's base (`recordBase`); the next sequence is computed
//    from the same read, never typed.
//  * `putImmutable` writes an object only when it is absent (If-None-Match: *).
//  * `promoteManifest` replaces the live manifest only if it is still the one the bundle was based
//    on (If-Match). A conflict is never retried and never overwritten.

const MANIFEST_CONTENT_TYPE = 'application/json';
// Objects are sent in one request and held in memory; multipart upload is not implemented.
const MAX_SINGLE_PUT_BYTES = 512 * 1024 * 1024;

class PublicationConflictError extends Error {
    constructor(message, live = null) {
        super(message);
        this.name = 'PublicationConflictError';
        this.live = live;
    }
}

class WriteNotAppliedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WriteNotAppliedError';
    }
}

const manifestKey = (channel) => `releases/${channel}/manifest.json`;
const sha256Of = (data) => crypto.createHash('sha256').update(data).digest('hex');
const sameBytes = (left, right) => left.length === right.length && sha256Of(left) === sha256Of(right);

async function readLiveManifest(store, config) {
    const found = await store.get(manifestKey(config.channel));
    if (!found.found) return null;
    const envelope = JSON.parse(found.bytes.toString('utf8'));
    const payload = verifyReleaseManifest(envelope, {
        expectedChannel: config.channel,
        trustedKeys: { [config.keyId]: config.publicKey }
    });
    return { bytes: found.bytes, envelope, payload, etag: found.etag };
}

function nextSequence(live) {
    return live ? live.payload.sequence + 1 : 1;
}

function describeLive(live) {
    if (!live) return 'there is no live manifest';
    const { payload } = live;
    const launcher = payload.launcher ? payload.launcher.version : 'none';
    return `the live manifest is sequence ${payload.sequence} (launcher ${launcher}, client ${payload.client.version})`;
}

function conflict(headline, live) {
    return new PublicationConflictError(
        `${headline} Nothing was overwritten and nothing was retried; ${describeLive(live)}. ` +
        'Prepare a new candidate from the current state, then stage and promote it again.',
        live
    );
}

// What the bundle was prepared against. The candidate's sequence and the entry it carries over are
// functions of that live manifest, so the bundle is only valid while the manifest is unchanged.
function recordBase(outputDirectory, live) {
    const metadataPath = path.join(outputDirectory, 'release.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    fs.writeFileSync(metadataPath, `${JSON.stringify({
        ...metadata,
        base: { etag: live ? live.etag : null, sequence: live ? live.payload.sequence : 0 }
    }, null, 2)}\n`, 'utf8');
}

function requireBase(metadata) {
    const base = metadata.base;
    const valid = base && Number.isSafeInteger(base.sequence) && base.sequence >= 0 &&
        (typeof base.etag === 'string' ? base.etag.length > 0 : base.etag === null && base.sequence === 0);
    if (!valid) {
        throw new Error('this bundle does not record the live manifest it was prepared against; prepare it again');
    }
    return base;
}

// Throws unless the live manifest is exactly the one the bundle was prepared against.
function requireLiveMatchesBase(live, base) {
    const liveEtag = live ? live.etag : null;
    if (liveEtag !== base.etag) {
        throw conflict(
            `The live manifest changed after this bundle was prepared (it was based on sequence ${base.sequence}).`,
            live
        );
    }
}

// An object of an immutable release. Returns what happened so the CLI can report it.
async function putImmutable(store, { key, file, contentType, name, resume = false, reuse = false, dryRun = false }) {
    const local = fs.readFileSync(file);
    const existing = await store.head(key);
    const verifyExisting = async (afterConflict) => {
        const remote = await store.get(key);
        if (!remote.found || !sameBytes(remote.bytes, local)) {
            throw new Error(
                afterConflict
                    ? `R2 object ${key} was created by another publication with different bytes between the check and the write; ` +
                      'it is never overwritten. Prepare the release again.'
                    : `R2 object ${key} differs from the local bundle; it is never overwritten`
            );
        }
        if (!reuse && !resume) {
            throw new Error(
                afterConflict
                    ? `immutable object ${key} was created by another publication while this one was staging; ` +
                      'use --resume only to verify it'
                    : `immutable object already exists in R2: ${key}; use --resume only to verify it`
            );
        }
        return { action: 'verified', size: local.length };
    };

    if (existing.found) {
        if (existing.size !== local.length) throw new Error(`R2 object ${key} differs from the local bundle; it is never overwritten`);
        return verifyExisting(false);
    }
    if (reuse) throw new Error(`known-good object is no longer available in R2: ${key}`);
    if (dryRun) return { action: 'would-upload', size: local.length };

    const outcome = await store.putIfAbsent(key, local, contentType);
    if (outcome.status === 'conflict') return verifyExisting(true);
    const readback = await store.get(key);
    if (!readback.found) throw new Error(`R2 object ${key} is missing right after the upload`);
    if (!sameBytes(readback.bytes, local)) {
        throw new Error(
            `R2 read-back of ${key} failed size or SHA-256 verification. The object was left in place and ` +
            `must not be used; the manifest was not changed. Investigate, then publish under a new ${name === 'candidate' ? 'sequence' : 'version'}.`
        );
    }
    return { action: 'uploaded', size: local.length };
}

// The only write that changes what users see.
async function promoteManifest(store, config, { bytes, base }) {
    const key = manifestKey(config.channel);
    let outcome;
    try {
        outcome = base.etag
            ? await store.putIfMatch(key, bytes, MANIFEST_CONTENT_TYPE, base.etag)
            : await store.putIfAbsent(key, bytes, MANIFEST_CONTENT_TYPE);
    } catch (error) {
        // The request may or may not have been applied: look, and classify what is there.
        let live;
        try {
            live = await readLiveManifest(store, config);
        } catch (readError) {
            throw new Error(
                `the manifest write failed (${error.message}) and the live manifest could not be read afterwards ` +
                `(${readError.message}). It may or may not have changed: run verify before doing anything else`
            );
        }
        if (live && sameBytes(live.bytes, bytes)) return { etag: live.etag, recovered: true };
        if ((live ? live.etag : null) === base.etag) {
            throw new WriteNotAppliedError(
                `the manifest write failed (${error.message}) and the live manifest is unchanged: nothing was written. ` +
                'The same promote may be run again'
            );
        }
        throw conflict(`The manifest write failed (${error.message}) and the live manifest is not the one this bundle was based on.`, live);
    }
    if (outcome.status === 'conflict') {
        let live = null;
        try {
            live = await readLiveManifest(store, config);
        } catch (_) {
            live = null;
        }
        throw conflict(`The live manifest was replaced while this promotion was running (HTTP ${outcome.httpStatus}).`, live);
    }
    const written = await store.get(key);
    if (!written.found || !sameBytes(written.bytes, bytes)) {
        throw new Error(
            'the live manifest is not the one written; another publication may have replaced it right after this one. ' +
            'Run verify'
        );
    }
    return { etag: written.etag, recovered: false };
}

// Proves, on a throwaway object, that R2 enforces the preconditions the publication depends on. The
// Cloudflare documentation lists If-Match and If-None-Match for PutObject but does not say that
// `If-None-Match: *` is enforced, so this is run once per bucket before the first real publication.
// It writes one tiny object under releases/<channel>/probes/ and leaves it there (the store has no
// unconditional delete by design); the Worker never serves that prefix.
async function probeConditionalWrites(store, channel, id = crypto.randomUUID()) {
    const key = `releases/${channel}/probes/conditional-${id}.txt`;
    const type = 'text/plain';
    const expect = (condition, message) => {
        if (!condition) throw new Error(`conditional writes are not enforced by this bucket: ${message}. Do not publish.`);
    };
    const first = await store.putIfAbsent(key, Buffer.from('one'), type);
    expect(first.status === 'created', 'the first create under If-None-Match: * was not accepted');
    const second = await store.putIfAbsent(key, Buffer.from('two'), type);
    expect(second.status === 'conflict', 'a second create under If-None-Match: * was accepted');
    let current = await store.get(key);
    expect(current.found && current.bytes.toString() === 'one', 'the second create replaced the object');
    const stale = await store.putIfMatch(key, Buffer.from('three'), type, '"00000000000000000000000000000000"');
    expect(stale.status === 'conflict', 'a write under a stale If-Match was accepted');
    current = await store.get(key);
    expect(current.bytes.toString() === 'one', 'the stale If-Match write replaced the object');
    const match = await store.putIfMatch(key, Buffer.from('four'), type, current.etag);
    expect(match.status === 'created', 'a write under the current If-Match was refused');
    current = await store.get(key);
    expect(current.bytes.toString() === 'four', 'the write under the current If-Match was not applied');
    return { key };
}

module.exports = {
    probeConditionalWrites,
    MANIFEST_CONTENT_TYPE,
    MAX_SINGLE_PUT_BYTES,
    PublicationConflictError,
    WriteNotAppliedError,
    describeLive,
    manifestKey,
    nextSequence,
    promoteManifest,
    putImmutable,
    readLiveManifest,
    recordBase,
    requireBase,
    requireLiveMatchesBase,
    sameBytes
};
