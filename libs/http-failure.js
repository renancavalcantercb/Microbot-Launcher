/**
 * One-line description of a failed HTTP call that is safe to log: the status code or the
 * transport error code, never the response body (OAuth error bodies can echo request data).
 */
function describeHttpFailure(error) {
    const status = error?.response?.status;
    if (Number.isInteger(status)) return `HTTP ${status}`;
    const code = typeof error?.code === 'string' ? error.code : null;
    return code ? `no response (${code})` : 'no response';
}

module.exports = { describeHttpFailure };
