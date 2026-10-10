const { EventEmitter } = require('events');
const { ClientLifecycle } = require('../libs/client-lifecycle');
const { LauncherTrayController } = require('../libs/launcher-tray');

class FakeTray extends EventEmitter {
    isDestroyed() { return false; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
}

function harness() {
    const app = new EventEmitter();
    app.quit = jest.fn();
    const window = new EventEmitter();
    window.hide = jest.fn();
    window.show = jest.fn();
    window.focus = jest.fn();
    window.restore = jest.fn();
    window.isMinimized = jest.fn().mockReturnValue(false);
    window.isDestroyed = jest.fn().mockReturnValue(false);
    const clientLifecycle = new ClientLifecycle();
    const menus = [];
    const controller = new LauncherTrayController({
        app,
        Tray: FakeTray,
        Menu: { buildFromTemplate: (items) => { menus.push(items); return items; } },
        iconPath: 'icon.png',
        launcherName: 'Microbot Cut Launcher',
        clientLifecycle,
        log: { info: jest.fn() }
    });
    controller.attach(window);
    return { app, window, clientLifecycle, controller, menus };
}

describe('LauncherTrayController', () => {
    test('hides instead of closing while a client is active', () => {
        const value = harness();
        const launch = value.clientLifecycle.beginLaunch();
        value.clientLifecycle.markStarted(launch, 1234);
        const event = { preventDefault: jest.fn() };

        value.window.emit('close', event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(value.window.hide).toHaveBeenCalled();
        expect(value.controller.tray.tooltip).toBe('Microbot Cut Launcher');
    });

    test('allows closing when there are no clients', () => {
        const value = harness();
        const event = { preventDefault: jest.fn() };
        value.window.emit('close', event);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    test('tray exit performs a real quit', () => {
        const value = harness();
        value.controller.ensureTray();
        const exit = value.menus.at(-1).find((item) => item.label === 'Exit');
        exit.click();
        expect(value.app.quit).toHaveBeenCalled();
    });
});
