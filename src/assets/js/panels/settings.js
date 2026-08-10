/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

import { changePanel, accountSelect, database, Slider, config, setStatus, popup, appdata, setBackground } from '../utils.js'
const { ipcRenderer } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

// ===== RAM PAR DÉFAUT SELON LA MACHINE =====
// Utilisé pour la config au premier lancement ET pour la ligne "Recommandé
// pour votre PC" dans les settings.
// Un simple pourcentage de la RAM totale ne suffit pas ici : PatateLand
// utilise des instances fortement moddées (des centaines de mods pour
// "Extra"), qui ont un besoin plancher en RAM peu importe la machine.
// MODPACK_MIN_MAX_GO fixe ce plancher pour le max recommandé (tant que la
// machine a la RAM totale pour le supporter sans dépasser maxAllowed,
// vérifié à l'affichage). En dessous de LOW_RAM_WARNING_GO de RAM totale,
// on affiche un avertissement plutôt qu'une recommandation trompeuse :
// aucun pourcentage ne rendra un pack lourd jouable sur une machine trop
// juste, mieux vaut orienter vers l'instance "Opti" (déjà prévue pour ça).
const MODPACK_MIN_MAX_GO = 4;
const LOW_RAM_WARNING_GO = 6;

function computeDefaultRam(totalMemGB) {
    const round1 = (n) => Math.round(n * 10) / 10;

    const min = totalMemGB <= 4 ? 1 : 2;
    let max = Math.max(round1(totalMemGB * 0.5), MODPACK_MIN_MAX_GO);

    // Garde-fou : le max ne doit jamais descendre sous le min (petites
    // configs, ex: 2 Go de RAM totale -> 50% = 1 Go < min par défaut).
    if (max <= min) max = min + 0.5;

    return { min, max };
}
// ===== FIN RAM PAR DÉFAUT =====

class Settings {
    static id = "settings";
    async init(config) {
        this.config = config;
        this.db = new database();
        this.navBTN()
        this.accounts()
        this.jeu()
        this.launcher()
        this.resourcePacks()
        this.shaderPacks()
        this.trayLogout()
        this.storage()
    }

    navBTN() {
        document.querySelector('.nav-box').addEventListener('click', e => {
            if (e.target.classList.contains('nav-settings-btn')) {
                let id = e.target.id

                let activeSettingsBTN = document.querySelector('.active-settings-BTN')
                let activeContainerSettings = document.querySelector('.active-container-settings')

                if (id == 'save') {
                    if (activeSettingsBTN) activeSettingsBTN.classList.toggle('active-settings-BTN');
                    document.querySelector('#account').classList.add('active-settings-BTN');
                    if (activeContainerSettings) activeContainerSettings.classList.toggle('active-container-settings');
                    document.querySelector(`#account-tab`).classList.add('active-container-settings');
                    return changePanel('home')
                }

                if (activeSettingsBTN) activeSettingsBTN.classList.toggle('active-settings-BTN');
                e.target.classList.add('active-settings-BTN');
                if (activeContainerSettings) activeContainerSettings.classList.toggle('active-container-settings');
                document.querySelector(`#${id}-tab`).classList.add('active-container-settings');

                // Le slider RAM doit s'initialiser APRES que le tab jeu soit visible
                // car il a besoin de la largeur du DOM pour calculer les positions
                if (id === 'jeu' && !this.sliderInitialized) {
                    this.initRamSlider();
                }
            }
        })
    }

    accounts() {
        document.querySelector('.accounts-list').addEventListener('click', async e => {
            let popupAccount = new popup()
            try {
                let id = e.target.id
                if (e.target.classList.contains('account')) {
                    popupAccount.openPopup({
                        title: 'Connexion',
                        content: 'Veuillez patienter...',
                        color: 'var(--color)'
                    })

                    if (id == 'add') {
                        document.querySelector('.login-back-btn').style.display = 'flex'
                        return changePanel('login')
                    }

                    let account = await this.db.readData('accounts', id);
                    let configClient = await this.setInstance(account);
                    await accountSelect(account);
                    configClient.account_selected = account.ID;
                    return await this.db.updateData('configClient', configClient);
                }

                if (e.target.closest(".delete-profile")) {
                    popupAccount.openPopup({
                        title: 'Connexion',
                        content: 'Veuillez patienter...',
                        color: 'var(--color)'
                    })
                    let deleteBtn = e.target.closest(".delete-profile")
                    await this.deleteAccount(deleteBtn.dataset.accountId);
                }
            } catch (err) {
                console.error(err)
            } finally {
                popupAccount.closePopup();
            }
        })
    }

    async deleteAccount(id, fromTray = false) {
        await this.db.deleteData('accounts', id);

        let deleteProfile = document.getElementById(`${id}`);
        let accountListElement = document.querySelector('.accounts-list');

        if (deleteProfile && accountListElement && deleteProfile.parentElement === accountListElement) {
            accountListElement.removeChild(deleteProfile);
        }

        let allAccounts = await this.db.readAllData('accounts');

        if (!allAccounts || allAccounts.length === 0) {
            let configClient = await this.db.readData('configClient');
            configClient.account_selected = null;
            await this.db.updateData('configClient', configClient);
            return changePanel('login');
        }

        let configClient = await this.db.readData('configClient');

        if (configClient.account_selected == id) {
            configClient.account_selected = allAccounts[0].ID
            accountSelect(allAccounts[0]);
            let newInstanceSelect = await this.setInstance(allAccounts[0]);
            configClient.instance_select = newInstanceSelect.instance_select
            await this.db.updateData('configClient', configClient);
        }

    }

    trayLogout() {
        ipcRenderer.on('tray-logout', async () => {
            try {
                let configClient = await this.db.readData('configClient');
                if (configClient.account_selected) {
                    await this.deleteAccount(configClient.account_selected, true);
                } else {
                    changePanel('login');
                }
            } catch (err) {
                console.error('Erreur lors de la déconnexion via le tray :', err);
            }
        });
    }

    async setInstance(auth) {
        let configClient = await this.db.readData('configClient')
        let instanceSelect = configClient.instance_select
        let instancesList = await config.getInstanceList()

        for (let instance of instancesList) {
            if (instance.whitelistActive) {
                let whitelist = instance.whitelist.find(whitelist => whitelist == auth.name)
                if (whitelist !== auth.name) {
                    if (instance.name == instanceSelect) {
                        let newInstanceSelect = instancesList.find(i => i.whitelistActive == false)
                        configClient.instance_select = newInstanceSelect.name
                        await setStatus(newInstanceSelect.status)
                    }
                }
            }
        }
        return configClient
    }

    async jeu() {
        let configClient = await this.db.readData('configClient');

        // ===== RAM - prépare les données, le slider s'init au clic sur l'onglet =====
        let totalMem = Math.trunc(os.totalmem() / 1073741824 * 10) / 10;
        this.totalMem = totalMem;
        let freeMem = Math.trunc(os.freemem() / 1073741824 * 10) / 10;

        document.getElementById("total-ram").textContent = `${totalMem} Go`;
        document.getElementById("free-ram").textContent = `${freeMem} Go`;

        let sliderDiv = document.querySelector(".memory-slider");
        sliderDiv.setAttribute("max", Math.trunc((80 * totalMem) / 100));

        if (!configClient.java_config) configClient.java_config = {};

        // Première configuration détectée (aucune valeur java_memory
        // enregistrée) : on calcule une valeur par défaut adaptée à la RAM
        // réelle de la machine plutôt que d'utiliser un fixe "2 Go / 8 Go".
        const isFirstRamConfig = !configClient.java_config.java_memory;

        let ram = configClient?.java_config?.java_memory ? {
            ramMin: configClient.java_config.java_memory.min,
            ramMax: configClient.java_config.java_memory.max
        } : (() => {
            const def = computeDefaultRam(totalMem);
            return { ramMin: def.min, ramMax: def.max };
        })();

        if (isFirstRamConfig) {
            configClient.java_config.java_memory = { min: ram.ramMin, max: ram.ramMax };
            await this.db.updateData('configClient', configClient);
        }

        // Cas où une config existante dépasse la RAM réellement disponible
        // sur CETTE machine (ex: profil copié depuis un PC plus costaud) :
        // on recalcule un défaut adapté plutôt que de retomber sur 2/8 Go.
        if (totalMem < ram.ramMin) {
            const def = computeDefaultRam(totalMem);
            configClient.java_config.java_memory = { min: def.min, max: def.max };
            await this.db.updateData('configClient', configClient);
            ram = { ramMin: def.min, ramMax: def.max };
        }

        let maxAllowed = Math.trunc((80 * totalMem) / 100);
        if (ram.ramMax > maxAllowed) {
            ram.ramMax = maxAllowed;
            configClient.java_config.java_memory = { min: ram.ramMin, max: ram.ramMax };
            await this.db.updateData('configClient', configClient);
        }

        // Recommandation basée sur la RAM totale de LA machine (indépendant
        // de la config actuellement enregistrée), pour que les gens aient un
        // repère fiable même s'ils ont déjà bricolé le slider sur un mauvais
        // réglage. maxAllowed est maintenant défini, donc le clamp est safe.
        const recommended = computeDefaultRam(totalMem);
        if (recommended.max > maxAllowed) recommended.max = maxAllowed;
        const recommendedEl = document.getElementById("recommended-ram");
        if (recommendedEl) recommendedEl.textContent = `${recommended.min} Go mini / ${recommended.max} Go maxi`;

        // Avertissement sur les configs vraiment trop justes pour un
        // modpack lourd : aucune valeur de RAM recommandée n'y changera
        // grand chose, on oriente plutôt vers l'instance "Opti".
        const ramWarningEl = document.getElementById("ram-low-warning");
        if (ramWarningEl) {
            ramWarningEl.style.display = totalMem < LOW_RAM_WARNING_GO ? 'flex' : 'none';
        }

        const applyRecommendedBtn = document.getElementById("apply-recommended-ram");
        if (applyRecommendedBtn) {
            applyRecommendedBtn.addEventListener('click', async () => {
                // this.ramSlider est défini dans initRamSlider(), déjà
                // appelé forcément à ce stade puisque ce bouton n'est visible
                // que dans l'onglet JEU, qui déclenche l'init du slider.
                if (!this.ramSlider) return;

                this.ramSlider.setMinValue(recommended.min);
                this.ramSlider.setMaxValue(recommended.max);

                let cfg = await this.db.readData('configClient');
                if (!cfg.java_config) cfg.java_config = {};
                cfg.java_config.java_memory = { min: recommended.min, max: recommended.max };
                await this.db.updateData('configClient', cfg);
            });
        }

        this.ramConfig = ram;
        this.sliderInitialized = false;

        let resolution = configClient?.game_config?.screen_size || { width: 1280, height: 720 };

        let width = document.querySelector(".width-size");
        let height = document.querySelector(".height-size");
        let resolutionReset = document.querySelector(".size-reset");

        width.value = resolution.width;
        height.value = resolution.height;

        width.addEventListener("change", async () => {
            let cfg = await this.db.readData('configClient');
            cfg.game_config.screen_size.width = width.value;
            await this.db.updateData('configClient', cfg);
        });

        height.addEventListener("change", async () => {
            let cfg = await this.db.readData('configClient');
            cfg.game_config.screen_size.height = height.value;
            await this.db.updateData('configClient', cfg);
        });

        resolutionReset.addEventListener("click", async () => {
            let cfg = await this.db.readData('configClient');
            cfg.game_config.screen_size = { width: '1280', height: '720' };
            width.value = '1280';
            height.value = '720';
            await this.db.updateData('configClient', cfg);
        });

        let fullscreenToggle = document.getElementById('fullscreen-toggle');
        let fullscreen = configClient?.game_config?.fullscreen || false;
        fullscreenToggle.checked = fullscreen;

        const updateResolutionState = (isFullscreen) => {
            width.disabled = isFullscreen;
            height.disabled = isFullscreen;
            resolutionReset.style.pointerEvents = isFullscreen ? 'none' : '';
            resolutionReset.style.opacity = isFullscreen ? '0.4' : '';
            width.style.opacity = isFullscreen ? '0.4' : '';
            height.style.opacity = isFullscreen ? '0.4' : '';
        };

        updateResolutionState(fullscreen);

        fullscreenToggle.addEventListener('change', async () => {
            let cfg = await this.db.readData('configClient');
            cfg.game_config.fullscreen = fullscreenToggle.checked;
            await this.db.updateData('configClient', cfg);
            updateResolutionState(fullscreenToggle.checked);
        });

        let consoleToggle = document.getElementById('console-toggle');
        let showConsole = configClient?.game_config?.show_console ?? false;
        consoleToggle.checked = showConsole;

        consoleToggle.addEventListener('change', async () => {
            let cfg = await this.db.readData('configClient');
            cfg.game_config.show_console = consoleToggle.checked;
            await this.db.updateData('configClient', cfg);
        });

        document.querySelectorAll('.number-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const target = btn.dataset.target;
                const input = document.querySelector(`.${target}`);
                if (!input) return;
                const step = parseInt(input.step) || 1;
                const min = parseInt(input.min) || 0;
                const max = parseInt(input.max) || 99999;
                let val = parseInt(input.value) || 0;
                if (btn.classList.contains('plus')) val = Math.min(val + step, max);
                else val = Math.max(val - step, min);
                input.value = val;
                input.dispatchEvent(new Event('change'));
            });
        });

        let javaPathText = document.querySelector(".java-path-txt");
        javaPathText.textContent = `${await appdata()}/${process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}/runtime`;

        let javaPath = configClient?.java_config?.java_path || 'Utiliser la version de java livre avec le launcher';
        let javaPathInputTxt = document.querySelector(".java-path-input-text");
        let javaPathInputFile = document.querySelector(".java-path-input-file");
        javaPathInputTxt.value = javaPath;

        document.querySelector(".java-path-set").addEventListener("click", async () => {
            javaPathInputFile.value = '';
            javaPathInputFile.click();
            await new Promise((resolve) => {
                let interval;
                interval = setInterval(() => {
                    if (javaPathInputFile.value != '') resolve(clearInterval(interval));
                }, 100);
            });
            if (javaPathInputFile.value.replace(".exe", '').endsWith("java") || javaPathInputFile.value.replace(".exe", '').endsWith("javaw")) {
                let cfg = await this.db.readData('configClient');
                let file = javaPathInputFile.files[0].path;
                javaPathInputTxt.value = file;
                cfg.java_config.java_path = file;
                await this.db.updateData('configClient', cfg);
            } else alert("Le nom du fichier doit être java ou javaw");
        });

        document.querySelector(".java-path-reset").addEventListener("click", async () => {
            let cfg = await this.db.readData('configClient');
            javaPathInputTxt.value = 'Utiliser la version de java livre avec le launcher';
            cfg.java_config.java_path = null;
            await this.db.updateData('configClient', cfg);
        });
    }

    initRamSlider() {
        if (this.sliderInitialized) return;

        let slider = new Slider(".memory-slider", parseFloat(this.ramConfig.ramMin), parseFloat(this.ramConfig.ramMax));
        this.ramSlider = slider;

        slider.on("change", async (min, max) => {
            let config = await this.db.readData('configClient');
            if (!config.java_config) config.java_config = {};
            config.java_config.java_memory = { min: min, max: max };
            await this.db.updateData('configClient', config);
        });

        this.sliderInitialized = true;
    }


    async launcher() {
        let configClient = await this.db.readData('configClient');

        let maxDownloadFiles = configClient?.launcher_config?.download_multi || 5;
        let maxDownloadFilesInput = document.querySelector(".max-files");
        let maxDownloadFilesReset = document.querySelector(".max-files-reset");
        maxDownloadFilesInput.value = maxDownloadFiles;

        maxDownloadFilesInput.addEventListener("change", async () => {
            let configClient = await this.db.readData('configClient')
            configClient.launcher_config.download_multi = maxDownloadFilesInput.value;
            await this.db.updateData('configClient', configClient);
        })

        maxDownloadFilesReset.addEventListener("click", async () => {
            let configClient = await this.db.readData('configClient')
            maxDownloadFilesInput.value = 5
            configClient.launcher_config.download_multi = 5;
            await this.db.updateData('configClient', configClient);
        })

        let themeBox = document.querySelector(".theme-box");
        let theme = configClient?.launcher_config?.theme || "auto";

        if (theme == "auto") {
            document.querySelector('.theme-btn-auto').classList.add('active-theme');
        } else if (theme == "dark") {
            document.querySelector('.theme-btn-sombre').classList.add('active-theme');
        } else if (theme == "light") {
            document.querySelector('.theme-btn-clair').classList.add('active-theme');
        }

        themeBox.addEventListener("click", async e => {
            if (e.target.classList.contains('theme-btn')) {
                let activeTheme = document.querySelector('.active-theme');
                if (e.target.classList.contains('active-theme')) return
                activeTheme?.classList.remove('active-theme');

                if (e.target.classList.contains('theme-btn-auto')) {
                    setBackground();
                    theme = "auto";
                    e.target.classList.add('active-theme');
                } else if (e.target.classList.contains('theme-btn-sombre')) {
                    setBackground(true);
                    theme = "dark";
                    e.target.classList.add('active-theme');
                } else if (e.target.classList.contains('theme-btn-clair')) {
                    setBackground(false);
                    theme = "light";
                    e.target.classList.add('active-theme');
                }

                let configClient = await this.db.readData('configClient')
                configClient.launcher_config.theme = theme;
                await this.db.updateData('configClient', configClient);
            }
        })

        let closeBox = document.querySelector(".close-box");
        let closeLauncher = configClient?.launcher_config?.closeLauncher || "close-launcher";

        if (closeLauncher == "close-launcher") {
            document.querySelector('.close-launcher')?.classList.add('active-close');

        } else if (closeLauncher == "close-window") {
            document.querySelector('.close-window')?.classList.add('active-close');
        } else if (closeLauncher == "close-none") {
            document.querySelector('.close-none')?.classList.add('active-close');
        }

        closeBox.addEventListener("click", async e => {
            if (e.target.closest('.close-btn')) {
                const btn = e.target.closest('.close-btn');
                let activeClose = document.querySelector('.active-close');
                if (btn.classList.contains('active-close')) return;
                activeClose?.classList.remove('active-close');

                let configClient = await this.db.readData('configClient');

                if (btn.classList.contains('close-none')) {
                    btn.classList.add('active-close');
                    configClient.launcher_config.closeLauncher = "close-none";
                } else if (btn.classList.contains('close-launcher')) {
                    // Réduire dans le tray
                    btn.classList.add('active-close');
                    configClient.launcher_config.closeLauncher = "close-launcher";
                    configClient.game_config.tray_on_launch = true;
                } else if (btn.classList.contains('close-window')) {
                    btn.classList.add('active-close');
                    configClient.launcher_config.closeLauncher = "close-window";
                    configClient.game_config.tray_on_launch = false;
}
                await this.db.updateData('configClient', configClient);
            }
        })

        // ===== AUTO LAUNCH =====
        let autoLaunchToggle = document.getElementById('autolaunch-toggle');
        if (process.platform === 'linux') {
            autoLaunchToggle.closest('.settings-elements-box')?.previousElementSibling?.remove();
            autoLaunchToggle.closest('.settings-elements-box')?.remove();
        } else {
            let cfgForAutoLaunch = await this.db.readData('configClient');
            let currentAutoLaunch = cfgForAutoLaunch?.launcher_config?.auto_launch ?? await ipcRenderer.invoke('get-auto-launch');
            autoLaunchToggle.checked = currentAutoLaunch;
            autoLaunchToggle.addEventListener('change', async () => {
                ipcRenderer.send('set-auto-launch', autoLaunchToggle.checked);
                let cfg = await this.db.readData('configClient');
                cfg.launcher_config.auto_launch = autoLaunchToggle.checked;
                await this.db.updateData('configClient', cfg);
            });
        }

        // ===== RAPPORTS DE CRASH (opt-in, désactivé par défaut) =====
        // ?? plutôt que || : on veut bien distinguer "jamais configuré"
        // (undefined -> false par défaut) de "explicitement mis à false"
        // par l'utilisateur, même si le résultat final est le même ici.
        let crashReportToggle = document.getElementById('crash-report-toggle');
        let sendCrashReports = configClient?.launcher_config?.send_crash_reports ?? false;
        crashReportToggle.checked = sendCrashReports;

        crashReportToggle.addEventListener('change', async () => {
            let cfg = await this.db.readData('configClient');
            cfg.launcher_config.send_crash_reports = crashReportToggle.checked;
            await this.db.updateData('configClient', cfg);
        });
    }
    // ===== APERÇU DU STOCKAGE =====
    // Catégories adaptées à la structure réelle de PatateLand (pas une
    // copie 1:1 d'un autre launcher) :
    // - Logs : dossiers logs/ de TOUTES les instances (créés nativement par
    //   Minecraft, ex: instances/Extra/logs/latest.log)
    // - Comptes : petits fichiers de config du launcher (electron-store),
    //   situés dans userData, PAS dans le dossier de jeu — taille estimée
    //   au mieux ; si les noms de fichiers réels diffèrent de la convention
    //   electron-store standard ("<name>.json"), ça affichera juste 0 sans
    //   rien casser.
    // - Ressources partagées : assets/ + libraries/ + versions/, réutilisées
    //   par toutes les instances (le vrai "cache" au sens Lunar Client).
    // - Runtime Java : JRE téléchargés par minecraft-java-core.
    // - Instances : tout le reste par instance (mods, saves, configs,
    //   screenshots...), donc le total des instances MOINS les logs déjà
    //   comptés à part.
    // - Autre : ce qui reste à la racine du dossier de données.
    formatStorageSize(bytes) {
        if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} Go`;
        if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} Mo`;
        if (bytes >= 1024) return `${Math.round(bytes / 1024)} Ko`;
        return `${bytes} o`;
    }

    // Scan récursif itératif (pas de récursion réelle, pour éviter tout
    // souci de pile sur une arborescence très profonde). Volontairement
    // synchrone : exécuté seulement à l'ouverture de l'onglet STOCKAGE, pas
    // en continu, donc un léger blocage ponctuel est acceptable.
    getStorageFolderSize(folderPath) {
        let total = 0;
        if (!fs.existsSync(folderPath)) return 0;

        const stack = [folderPath];
        while (stack.length) {
            const current = stack.pop();
            let entries;
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(full);
                } else {
                    try { total += fs.statSync(full).size; } catch {}
                }
            }
        }
        return total;
    }

    // Supprime uniquement le CONTENU d'un dossier (fichiers et sous-dossiers),
    // en conservant le dossier lui-même. Chaque suppression est isolée dans
    // son propre try/catch : un fichier verrouillé (ex: partie en cours) est
    // simplement ignoré plutôt que de faire échouer tout le nettoyage.
    clearStorageFolderContents(folderPath) {
        if (!fs.existsSync(folderPath)) return;
        let entries;
        try {
            entries = fs.readdirSync(folderPath, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(folderPath, entry.name);
            try {
                fs.rmSync(full, { recursive: true, force: true });
            } catch {
                // Fichier verrouillé ou inaccessible : on l'ignore et on
                // continue avec le reste.
            }
        }
    }

    async storage() {
        const stockageNavBtn = document.getElementById('stockage');
        if (!stockageNavBtn) return;
        stockageNavBtn.addEventListener('click', () => this.loadStorageOverview());

        document.getElementById('storage-open-logs')?.addEventListener('click', () => {
            if (!this.storageLogsPath) return;
            ipcRenderer.invoke('open-folder', this.storageLogsPath);
        });

        document.getElementById('storage-clear-logs')?.addEventListener('click', () => {
            if (!this.storageLogsPath) return;
            if (!confirm("Vider les logs de l'instance actuelle ? Assure-toi qu'aucune partie n'est en cours.")) return;
            this.clearStorageFolderContents(this.storageLogsPath);
            this.loadStorageOverview();
        });

        document.getElementById('storage-clear-cache')?.addEventListener('click', () => {
            if (!this.storageCachePaths) return;
            if (!confirm('Vider le cache Minecraft (assets, bibliothèques, versions) ? Le prochain lancement sera plus long. Assure-toi qu\'aucune partie n\'est en cours.')) return;
            for (const cachePath of this.storageCachePaths) {
                this.clearStorageFolderContents(cachePath);
            }
            this.loadStorageOverview();
        });
    }

    async loadStorageOverview() {
        const appdataPath = await appdata();
        const dataDir = process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`;
        const root = path.join(appdataPath, dataDir);

        const configClient = await this.db.readData('configClient');
        const currentInstance = configClient?.instance_select;

        this.storageLogsPath = currentInstance ? path.join(root, 'instances', currentInstance, 'logs') : null;
        this.storageCachePaths = ['assets', 'libraries', 'versions'].map(f => path.join(root, f));

        // Logs de TOUTES les instances (vue d'ensemble), même si les
        // boutons Ouvrir/Vider ne concernent que l'instance sélectionnée.
        let instanceNames = [];
        try {
            instanceNames = fs.readdirSync(path.join(root, 'instances'), { withFileTypes: true })
                .filter(e => e.isDirectory())
                .map(e => e.name);
        } catch {}

        let logsSize = 0;
        for (const name of instanceNames) {
            logsSize += this.getStorageFolderSize(path.join(root, 'instances', name, 'logs'));
        }

        const cacheSize = this.storageCachePaths.reduce((sum, p) => sum + this.getStorageFolderSize(p), 0);
        const runtimeSize = this.getStorageFolderSize(path.join(root, 'runtime'));

        let accountsSize = 0;
        try {
            const userDataPath = await ipcRenderer.invoke('path-user-data');
            for (const file of ['accounts.json', 'configClient.json']) {
                const full = path.join(userDataPath, file);
                if (fs.existsSync(full)) accountsSize += fs.statSync(full).size;
            }
        } catch {}

        const instancesTotal = this.getStorageFolderSize(path.join(root, 'instances'));
        const instancesSize = Math.max(0, instancesTotal - logsSize);

        let otherSize = 0;
        try {
            const known = new Set(['instances', 'assets', 'libraries', 'versions', 'runtime']);
            const rootEntries = fs.readdirSync(root, { withFileTypes: true });
            for (const entry of rootEntries) {
                if (known.has(entry.name)) continue;
                const full = path.join(root, entry.name);
                if (entry.isDirectory()) otherSize += this.getStorageFolderSize(full);
                else { try { otherSize += fs.statSync(full).size; } catch {} }
            }
        } catch {}

        const categories = [
            { label: 'Logs', size: logsSize, color: '#3498db' },
            { label: 'Comptes', size: accountsSize, color: '#9b59b6' },
            { label: 'Ressources partagées', size: cacheSize, color: '#2ecc71' },
            { label: 'Runtime Java', size: runtimeSize, color: '#f39c12' },
            { label: 'Instances', size: instancesSize, color: '#e74c3c' },
            { label: 'Autre', size: otherSize, color: '#95a5a6' }
        ];

        const total = categories.reduce((sum, c) => sum + c.size, 0);

        const barEl = document.getElementById('storage-bar');
        const legendEl = document.getElementById('storage-legend');
        const totalEl = document.getElementById('storage-total');
        if (!barEl || !legendEl || !totalEl) return;

        barEl.innerHTML = total > 0
            ? categories
                .filter(c => c.size > 0)
                .map(c => `<div class="storage-bar-segment" style="width:${(c.size / total * 100).toFixed(2)}%; background:${c.color};"></div>`)
                .join('')
            : '';

        legendEl.innerHTML = categories.map(c => `
            <div class="storage-legend-item">
                <span class="storage-legend-dot" style="background:${c.color};"></span>
                ${c.label} — ${this.formatStorageSize(c.size)}
            </div>
        `).join('');

        totalEl.textContent = `Total : ${this.formatStorageSize(total)}`;
    }
    // ===== FIN APERÇU DU STOCKAGE =====

    // ===== RESOURCE PACKS =====
    async resourcePacks() {
        const appdataPath = await appdata();
        const dataDir = process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`;

        const getRpFolder = async () => {
            const configClient = await this.db.readData('configClient');
            const instanceName = configClient.instance_select;
            const folder = path.join(appdataPath, dataDir, 'instances', instanceName, 'resourcepacks');
            if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
            return folder;
        };

        this.rpFolder = await getRpFolder();

        document.querySelector('#resourcepacks').addEventListener('click', async () => {
            this.rpFolder = await getRpFolder();
            this.loadResourcePacksList();
        });

        document.querySelector('.rp-add-btn').addEventListener('click', async () => {
            const filePath = await ipcRenderer.invoke('dialog-open-resourcepack');
            if (!filePath) return;
            const dest = path.join(this.rpFolder, path.basename(filePath));
            try {
                fs.copyFileSync(filePath, dest);
                this.loadResourcePacksList();
            } catch (err) {
                console.error('Erreur lors de la copie du resource pack :', err);
                alert('Impossible de copier le resource pack.');
            }
        });

        document.querySelector('.rp-open-folder-btn').addEventListener('click', () => {
            ipcRenderer.invoke('open-folder', this.rpFolder);
        });
    }

    loadResourcePacksList() {
        const list = document.querySelector('.resourcepacks-list');
        list.innerHTML = '';
        let files;
        try {
            files = fs.readdirSync(this.rpFolder).filter(f => f.endsWith('.zip') || fs.statSync(path.join(this.rpFolder, f)).isDirectory());
        } catch { files = []; }

        if (files.length === 0) {
            list.innerHTML = '<div class="rp-empty-msg">Aucun resource pack installé.</div>';
            return;
        }
        files.forEach(file => {
            const item = document.createElement('div');
            item.classList.add('rp-item');
            item.innerHTML = `<div class="rp-item-name">${file}</div><div class="rp-item-delete rp-delete-btn" data-file="${file}">Supprimer</div>`;
            list.appendChild(item);
        });
        list.querySelectorAll('.rp-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const fileName = e.target.getAttribute('data-file');
                const filePath = path.join(this.rpFolder, fileName);
                try {
                    if (fs.statSync(filePath).isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
                    else fs.unlinkSync(filePath);
                    this.loadResourcePacksList();
                } catch (err) { alert('Impossible de supprimer le resource pack.'); }
            });
        });
    }
    // ===== FIN RESOURCE PACKS =====

    // ===== SHADER PACKS =====
    async shaderPacks() {
        const appdataPath = await appdata();
        const dataDir = process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`;

        const getSpFolder = async () => {
            const configClient = await this.db.readData('configClient');
            const instanceName = configClient.instance_select;
            const folder = path.join(appdataPath, dataDir, 'instances', instanceName, 'shaderpacks');
            if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
            return folder;
        };

        this.spFolder = await getSpFolder();

        document.querySelector('#shaderpacks').addEventListener('click', async () => {
            this.spFolder = await getSpFolder();
            this.loadShaderPacksList();
        });

        document.querySelector('.sp-add-btn').addEventListener('click', async () => {
            const filePath = await ipcRenderer.invoke('dialog-open-shaderpack');
            if (!filePath) return;
            const dest = path.join(this.spFolder, path.basename(filePath));
            try {
                fs.copyFileSync(filePath, dest);
                this.loadShaderPacksList();
            } catch (err) { alert('Impossible de copier le shader.'); }
        });

        document.querySelector('.sp-open-folder-btn').addEventListener('click', () => {
            ipcRenderer.invoke('open-folder', this.spFolder);
        });
    }

    loadShaderPacksList() {
        const list = document.querySelector('.shaderpacks-list');
        list.innerHTML = '';
        let files;
        try {
            files = fs.readdirSync(this.spFolder).filter(f => f.endsWith('.zip') || fs.statSync(path.join(this.spFolder, f)).isDirectory());
        } catch { files = []; }

        if (files.length === 0) {
            list.innerHTML = '<div class="sp-empty-msg">Aucun shader installé.</div>';
            return;
        }
        files.forEach(file => {
            const item = document.createElement('div');
            item.classList.add('rp-item');
            item.innerHTML = `<div class="rp-item-name">${file}</div><div class="sp-delete-btn" data-file="${file}">Supprimer</div>`;
            list.appendChild(item);
        });
        list.querySelectorAll('.sp-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const fileName = e.target.getAttribute('data-file');
                const filePath = path.join(this.spFolder, fileName);
                try {
                    if (fs.statSync(filePath).isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
                    else fs.unlinkSync(filePath);
                    this.loadShaderPacksList();
                } catch (err) { alert('Impossible de supprimer le shader.'); }
            });
        });
    }
    // ===== FIN SHADER PACKS =====
}
export default Settings;