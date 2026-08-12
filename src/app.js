/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { app, ipcMain, nativeTheme, dialog, shell, Tray, nativeImage, Notification } = require('electron');
const { Microsoft } = require('minecraft-java-core');
const { autoUpdater } = require('electron-updater')
const notifier = require('node-notifier');

const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const UpdateWindow = require("./assets/js/windows/updateWindow.js");
const MainWindow = require("./assets/js/windows/mainWindow.js");
const LogWindow = require("./assets/js/windows/logWindow.js");
const TrayMenu = require("./assets/js/windows/trayMenu.js");

let dev = process.env.NODE_ENV === 'dev';

if (dev) {
    let appPath = path.resolve('./data/Launcher').replace(/\\/g, '/');
    let appdata = path.resolve('./data').replace(/\\/g, '/');
    if (!fs.existsSync(appPath)) fs.mkdirSync(appPath, { recursive: true });
    if (!fs.existsSync(appdata)) fs.mkdirSync(appdata, { recursive: true });
    app.setPath('userData', appPath);
    app.setPath('appData', appdata)
}

Store.initRenderer();

app.setName('PatateLand');
app.setAppUserModelId('fr.patateland.launcher');

// ===== AUTO LAUNCH (démarrage avec Windows/macOS) =====
// Ajout de logs + try/catch : avant, une erreur de setLoginItemSettings
// (chemin d'exe invalide, permissions, etc.) échouait silencieusement, sans
// aucune trace nulle part. Si l'auto-launch continue à ne pas fonctionner
// après le fix côté settings.js (qui affiche maintenant l'état RÉEL de
// Windows au lieu de la config cachée), ces logs dans la console DevTools
// (ou le fichier de logs si --enable-logging est utilisé) diront pourquoi.
function setAutoLaunch(enabled) {
    try {
        if (process.platform === 'darwin') {

            const exePath = app.getPath('exe');
            const appPath = exePath.includes('.app/') 
                ? exePath.split('.app/')[0] + '.app'
                : exePath;
            app.setLoginItemSettings({
                openAtLogin: enabled,
                name: 'PatateLand',
                path: appPath
            });
            console.log('[AutoLaunch] setLoginItemSettings (darwin) appelé, enabled =', enabled, 'path =', appPath);
        } else {
            console.log('[AutoLaunch] setLoginItemSettings (win/linux) appelé, enabled =', enabled, 'execPath =', process.execPath);
            app.setLoginItemSettings({
                openAtLogin: enabled,
                name: 'PatateLand',
                path: process.execPath
            });
        }

        // Relit immédiatement ce que Windows/macOS a réellement enregistré,
        // pour confirmer que l'appel a bien été pris en compte plutôt que
        // de supposer que ça a marché juste parce qu'aucune exception n'a
        // été levée (setLoginItemSettings peut échouer silencieusement dans
        // certains cas selon l'OS/la config).
        const verif = app.getLoginItemSettings();
        console.log('[AutoLaunch] Relecture après appel :', JSON.stringify(verif));
    } catch (err) {
        console.error('[AutoLaunch] Erreur lors de setLoginItemSettings :', err);
    }
}

async function restoreAutoLaunch() {
    try {
        const Store = require('electron-store');
        const store = new Store({ name: 'configClient' });
        const configClient = store.get('data');
        console.log('[AutoLaunch] restoreAutoLaunch() - configClient.launcher_config.auto_launch =', configClient?.launcher_config?.auto_launch);
        if (configClient?.launcher_config?.auto_launch === true) {
            setAutoLaunch(true);
        }
    } catch(e) {
        console.error('[AutoLaunch] Erreur dans restoreAutoLaunch :', e);
    }
}

function sendNotification({ title, body, silent = false, onClick = null }) {
    if (!Notification.isSupported()) return;
    const notif = new Notification({
        title,
        body,
        icon: path.join(__dirname, 'assets/images/icon/icon.png'),
        silent
    });
    if (onClick) notif.on('click', onClick);
    notif.show();
}

let tray = null;
let trayInstances = [];
let trayRunning = [];

function focusMainWindowAndSend(channel, payload) {
    let win = MainWindow.getWindow();
    if (!win || win.isDestroyed()) {
        MainWindow.createWindow();
        win = MainWindow.getWindow();
        win.webContents.once('did-finish-load', () => {
            win.show();
            win.focus();
            win.webContents.send(channel, payload);
        });
    } else {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        win.webContents.send(channel, payload);
    }
}

function createTray() {
    if (tray) return;
    const iconPath = path.join(__dirname, 'assets/images/icon/icon.png');
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon);

    tray.setToolTip('PatateLand Launcher');

    tray.on('click', (event, bounds) => TrayMenu.toggleWindow(bounds));
    tray.on('right-click', (event, bounds) => TrayMenu.toggleWindow(bounds));

    tray.on('double-click', () => {
        const win = MainWindow.getWindow();
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    });
}

ipcMain.on('update-tray-instances', (_, instanceNames) => {
    trayInstances = Array.isArray(instanceNames) ? instanceNames : [];
    TrayMenu.updateInstances(trayInstances, trayRunning);
});

ipcMain.on('update-tray-running', (_, runningNames) => {
    trayRunning = Array.isArray(runningNames) ? runningNames : [];
    TrayMenu.updateInstances(trayInstances, trayRunning);
});

ipcMain.on('trayPopup-request-instances', (event) => {
    event.sender.send('trayPopup-instances', { instances: trayInstances, running: trayRunning });
});

ipcMain.on('trayPopup-open-launcher', () => {
    TrayMenu.hideWindow();
    const win = MainWindow.getWindow();
    if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    }
});

ipcMain.on('trayPopup-launch-instance', (_, name) => {
    TrayMenu.hideWindow();
    focusMainWindowAndSend('tray-launch-instance', name);
});

ipcMain.on('trayPopup-open-settings', () => {
    TrayMenu.hideWindow();
    focusMainWindowAndSend('tray-open-settings');
});

ipcMain.on('trayPopup-logout', () => {
    TrayMenu.hideWindow();
    focusMainWindowAndSend('tray-logout');
});

ipcMain.on('trayPopup-quit', () => {
    app.isQuitting = true;
    app.quit();
});


if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on('second-instance', () => {
        const win = MainWindow.getWindow();
        if (win && !win.isDestroyed()) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
        }
    });

    app.whenReady().then(async () => {
        await restoreAutoLaunch();

        if (dev) {

            UpdateWindow.createWindow();
            scheduleUpdateCheck();
            return;

        }

        UpdateWindow.createWindow();
    });

ipcMain.on('main-window-open', () => {
    MainWindow.createWindow();
    if (!tray) createTray();
    scheduleUpdateCheck();
})
ipcMain.on('main-window-dev-tools', () => MainWindow.getWindow().webContents.openDevTools({ mode: 'detach' }))
ipcMain.on('main-window-dev-tools-close', () => MainWindow.getWindow().webContents.closeDevTools())
ipcMain.on('main-window-close', () => MainWindow.destroyWindow())
ipcMain.on('main-window-reload', () => MainWindow.getWindow().reload())
ipcMain.on('main-window-progress', (event, options) => MainWindow.getWindow().setProgressBar(options.progress / options.size))
ipcMain.on('main-window-progress-reset', () => MainWindow.getWindow().setProgressBar(-1))
ipcMain.on('main-window-progress-load', () => MainWindow.getWindow().setProgressBar(2))

let trayNotifShown = false;

ipcMain.on('main-window-minimize', () => {
    const win = MainWindow.getWindow();

    if (process.platform === 'darwin') {
        win.minimize();
    } else {
        win.hide();
    }

    if (!trayNotifShown) {
        trayNotifShown = true;
        sendNotification({
            title: 'PatateLand Launcher',
            body: 'Le launcher tourne en arriere-plan. Cliquez ici ou double-cliquez sur l\'icone pour le rouvrir.',
            silent: false,
            onClick: () => {
                const win = MainWindow.getWindow();
                if (win.isMinimized()) win.restore();
                win.show();
                win.focus();
            }
        });
    }
})

ipcMain.on('game-notification', (_, { title, body }) => {
    sendNotification({ title, body, silent: false });
})

ipcMain.on('update-available-notification', (_, { title, body, url }) => {
    sendNotification({
        title,
        body,
        silent: false,
        onClick: () => shell.openExternal(url)
    });
})


ipcMain.on('log-window-open', (_, id, title) => LogWindow.createWindow(id, title))
ipcMain.on('log-window-close', (_, id) => LogWindow.destroyWindow(id))
ipcMain.on('log-window-minimize', (_, id) => LogWindow.getWindow(id)?.minimize())

ipcMain.on('log-send', (_, id, data) => {
    const win = LogWindow.getWindow(id);
    if (win) win.webContents.send('log-data', data);
})

ipcMain.on('log-status', (_, id, status) => {
    const win = LogWindow.getWindow(id);
    if (win) win.webContents.send('log-status', status);
})

ipcMain.on('update-window-close', () => UpdateWindow.destroyWindow())
ipcMain.on('update-window-dev-tools', () => UpdateWindow.getWindow().webContents.openDevTools({ mode: 'detach' }))
ipcMain.on('update-window-progress', (event, options) => UpdateWindow.getWindow().setProgressBar(options.progress / options.size))
ipcMain.on('update-window-progress-reset', () => UpdateWindow.getWindow().setProgressBar(-1))
ipcMain.on('update-window-progress-load', () => UpdateWindow.getWindow().setProgressBar(2))

ipcMain.handle('path-user-data', () => app.getPath('userData'))
ipcMain.handle('appData', e => app.getPath('appData'))

ipcMain.on('main-window-maximize', () => {
    if (MainWindow.getWindow().isMaximized()) {
        MainWindow.getWindow().unmaximize();
    } else {
        MainWindow.getWindow().maximize();
    }
})

ipcMain.on('main-window-hide', () => MainWindow.getWindow().hide())
ipcMain.on('main-window-show', () => {
    const win = MainWindow.getWindow();
    if (win.isMinimized()) win.restore();
    win.show();
})

ipcMain.handle('get-auto-launch', () => {
    const settings = app.getLoginItemSettings();
    console.log('[AutoLaunch] get-auto-launch invoqué, résultat complet :', JSON.stringify(settings));
    return settings.openAtLogin;
});

ipcMain.on('set-auto-launch', (_, enabled) => {
    setAutoLaunch(enabled);
});

ipcMain.handle('Microsoft-window', async (_, client_id) => {
    return await new Microsoft(client_id).getAuth();
})

ipcMain.handle('is-dark-theme', (_, theme) => {
    if (theme === 'dark') return true
    if (theme === 'light') return false
    return nativeTheme.shouldUseDarkColors;
})

ipcMain.handle('dialog-open-resourcepack', async () => {
    const result = await dialog.showOpenDialog(MainWindow.getWindow(), {
        title: 'Selectionner un Resource Pack',
        filters: [{ name: 'Resource Pack', extensions: ['zip'] }],
        properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.handle('dialog-open-shaderpack', async () => {
    const result = await dialog.showOpenDialog(MainWindow.getWindow(), {
        title: 'Selectionner un Shader',
        filters: [{ name: 'Shader Pack', extensions: ['zip'] }],
        properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.handle('open-folder', (_, folderPath) => {
    shell.openPath(folderPath);
});

app.on('before-quit', () => {
    app.isQuitting = true;
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    const win = MainWindow.getWindow();
    if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    }
});

autoUpdater.autoDownload = false;

let isFirstUpdateCheck = true;

function scheduleUpdateCheck() {
    autoUpdater.checkForUpdates().catch(() => {});

    setInterval(() => {
        isFirstUpdateCheck = false;
        autoUpdater.checkForUpdates().catch(() => {});
    }, 10 * 60 * 1000);
}

ipcMain.handle('update-app', async () => {
    return await new Promise(async (resolve, reject) => {
        autoUpdater.checkForUpdates().then(res => {
            resolve(res);
        }).catch(error => {
            reject({
                error: true,
                message: error
            })
        })
    })
})

autoUpdater.on('update-available', (info) => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) updateWindow.webContents.send('updateAvailable');

    if (isFirstUpdateCheck) return;

    sendNotification({
        title: 'PatateLand - Mise a jour disponible !',
        body: 'Une nouvelle version est disponible. Double-cliquez pour relancer et mettre à jour.',
        silent: false,
        onClick: () => {
            app.relaunch();
            app.exit(0);
        }
    });
});

ipcMain.on('start-update', () => {
    autoUpdater.downloadUpdate();
})

autoUpdater.on('update-not-available', () => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) updateWindow.webContents.send('update-not-available');
});

autoUpdater.on('update-downloaded', () => {
    autoUpdater.quitAndInstall();
});

autoUpdater.on('download-progress', (progress) => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) updateWindow.webContents.send('download-progress', progress);
})

autoUpdater.on('error', (err) => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) updateWindow.webContents.send('error', err);
});
}