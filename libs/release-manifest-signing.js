const crypto = require('crypto');

const { validatePayload } = require('./release-manifest');

function canonicalJson(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('manifest numbers must be finite');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(',')}}`;
    }
    throw new Error('manifest contains an unsupported JSON value');
}

function signReleaseManifest(payload, { keyId, privateKeyPem }) {
    validatePayload(payload, payload && payload.channel);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId || '')) {
        throw new Error('release signing key ID is invalid');
    }

    const privateKey = crypto.createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== 'rsa') {
        throw new Error('release signing key must be RSA');
    }
    const payloadBytes = Buffer.from(canonicalJson(payload), 'utf8');
    return {
        keyId,
        payload: payloadBytes.toString('base64'),
        signature: crypto
            .sign('RSA-SHA256', payloadBytes, privateKey)
            .toString('base64')
    };
}

module.exports = {
    canonicalJson,
    signReleaseManifest
};
