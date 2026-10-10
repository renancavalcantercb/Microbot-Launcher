const { ClientLifecycle } = require('../libs/client-lifecycle');

describe('ClientLifecycle', () => {
    test('tracks pending, active and stopped clients', () => {
        const lifecycle = new ClientLifecycle();
        const changes = [];
        lifecycle.on('change', (status) => changes.push(status));

        const first = lifecycle.beginLaunch();
        expect(lifecycle.status()).toEqual({ pending: 1, active: 0, total: 1 });
        lifecycle.markStarted(first, 1234);
        expect(lifecycle.status()).toEqual({ pending: 0, active: 1, total: 1 });
        lifecycle.markStopped(first);
        expect(lifecycle.hasClients()).toBe(false);
        expect(changes).toHaveLength(3);
    });

    test('removes failed pending launches', () => {
        const lifecycle = new ClientLifecycle();
        const launch = lifecycle.beginLaunch();
        lifecycle.markFailed(launch);
        expect(lifecycle.status()).toEqual({ pending: 0, active: 0, total: 0 });
    });
});
