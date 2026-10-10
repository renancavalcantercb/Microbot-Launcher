class LauncherTrayController {
    constructor({ app, Tray, Menu, iconPath, launcherName, clientLifecycle, log }) {
        this.app = app;
        this.Tray = Tray;
        this.Menu = Menu;
        this.iconPath = iconPath;
        this.launcherName = launcherName;
        this.clientLifecycle = clientLifecycle;
        this.log = log;
        this.window = null;
        this.tray = null;
        this.isQuitting = false;

        this.clientLifecycle.on('change', () => this.updateMenu());
        this.app.on('before-quit', () => {
            this.isQuitting = true;
        });
    }

    attach(window) {
        this.window = window;
        window.on('close', (event) => {
            if (this.isQuitting || !this.clientLifecycle.hasClients()) return;
            event.preventDefault();
            window.hide();
            this.ensureTray();
            this.log.info('Launcher window hidden; client authorization broker remains active.');
        });
    }

    showWindow() {
        if (!this.window || this.window.isDestroyed()) return;
        if (this.window.isMinimized()) this.window.restore();
        this.window.show();
        this.window.focus();
    }

    ensureTray() {
        if (this.tray && !this.tray.isDestroyed()) {
            this.updateMenu();
            return;
        }
        this.tray = new this.Tray(this.iconPath);
        this.tray.setToolTip(this.launcherName);
        this.tray.on('click', () => this.showWindow());
        this.tray.on('double-click', () => this.showWindow());
        this.updateMenu();
    }

    updateMenu() {
        if (!this.tray || this.tray.isDestroyed()) return;
        const status = this.clientLifecycle.status();
        const clientLabel = status.active === 1
            ? '1 active client'
            : `${status.active} active clients`;
        this.tray.setContextMenu(this.Menu.buildFromTemplate([
            { label: 'Open launcher', click: () => this.showWindow() },
            { label: clientLabel, enabled: false },
            { type: 'separator' },
            {
                label: 'Exit',
                click: () => {
                    this.isQuitting = true;
                    this.app.quit();
                }
            }
        ]));
    }
}

module.exports = { LauncherTrayController };
