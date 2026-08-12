/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */
import { config as configModule, database, logger, changePanel, appdata, setStatus, pkg, popup } from '../utils.js'
import { injectServer } from '../utils/serversDat.js'

const { Launch } = require('minecraft-java-core')
const { shell, ipcRenderer } = require('electron')
const fs = require('fs')
const path = require('path')

// ===== WEBHOOK DISCORD POUR LES CRASH REPORTS (lecture protégée) =====
// Volontairement PAS un `import` statique vers un module JS ni
// `import.meta.url` : les deux sont analysés/résolus AVANT l'exécution du
// code (et `import.meta` peut même être une erreur de syntaxe pure selon le
// bundler/transpileur utilisé) — dans les deux cas, impossible à protéger
// avec un try/catch, ça fait planter tout le fichier au chargement (écran
// blanc). __dirname + require() dynamique, eux, s'exécutent normalement au
// moment de l'appel de la fonction, donc une erreur (fichier absent,
// invalide...) est une Error JS ordinaire, capturable normalement.
//
// Crée un fichier "webhook.config.json" à côté de home.js (même dossier)
// avec ce contenu pour activer l'envoi Discord :
//   { "CRASH_REPORT_DISCORD_WEBHOOK": "https://discord.com/api/webhooks/..." }
// Ce fichier JSON réel doit être gitignoré (voir .gitignore) ; seul
// "webhook.config.example.json" (vide) doit être commité.
function getCrashReportWebhook() {
    try {
        const configPath = path.join(__dirname, 'webhook.config.json');
        if (!fs.existsSync(configPath)) return '';
        const raw = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed?.CRASH_REPORT_DISCORD_WEBHOOK || '';
    } catch (err) {
        console.error('webhook.config.json illisible ou invalide (fonctionnalité optionnelle, désactivée) :', err);
        return '';
    }
}

const CRASH_REPORT_DISCORD_WEBHOOK = getCrashReportWebhook();
// ===== FIN WEBHOOK DISCORD =====

// Descriptions affichées via l'icône "?" pour chaque instance.
// Les clés doivent correspondre exactement au champ "name" de l'instance.
const instanceDescriptions = {
    "Event": "Instance dédiée aux événements spéciaux et temporaires.",
    "Extra": "Instance avec des fonctionnalités et du contenu supplémentaire.",
    "Opti": "Instance optimisée pour de meilleures performances, idéale pour les configurations modestes."
}

// Map partagée au niveau module : instanceName -> instance de Launch en cours.
// Volontairement en dehors de la classe pour que l'état "en cours" reste
// cohérent même si un nouveau Home() est recréé lors d'un changement de panel
// (sinon un ancien Home() pouvait garder une Map différente de celui affiché).
const activeLaunches = new Map();

// Prévient le processus principal (main.js/app.js) de la liste actuelle des
// instances en cours d'exécution, pour que le popup du tray puisse afficher
// un badge "En cours" à côté du nom, comme dans le sélecteur d'instance du home.
function notifyTrayRunning() {
    ipcRenderer.send('update-tray-running', Array.from(activeLaunches.keys()));
}

class Home {
    static id = "home";

    async init(config) {
        this.config = config;
        this.db = new database();
        // instanceName -> instance de Launch en cours (permet le multi-lancement)
        // Map partagée au niveau module (et non plus par instance de Home)
        // pour que le badge "En cours" reste cohérent même si un nouveau
        // Home() est recréé lors d'un changement de panel.
        this.activeLaunches = activeLaunches;

        this.news()
        this.socialLick()
        this.instancesSelect()
        this.reviewBanner()
        this.partnerBanner()

        const db = this.db;
        setInterval(async () => {
            try {
                let configClient = await db.readData('configClient')
                let instanceList = await configModule.getInstanceList()
                let options = instanceList.find(i => i.name == configClient.instance_select)
                if (options?.status) await setStatus(options.status)
            } catch(e) { console.log("INTERVAL ERR:", e.message) }
        }, 15000)

        // Rafraîchissement automatique des news toutes les 5 minutes
        setInterval(() => {
            this.news();
        }, 3 * 60 * 1000);

        document.querySelector('.settings-btn').addEventListener('click', e => changePanel('settings'))

        // Ouvre la page profil du site (Azuriom) où le joueur peut changer
        // son pseudo, son skin, son mot de passe, etc. — plutôt que les
        // paramètres du launcher, qui restent accessibles via l'icône ⚙.
        document.querySelector('.player-head').addEventListener('click', () => {
            if (typeof this.config.online === 'string') {
                shell.openExternal(`${this.config.online}/profile`);
            } else {
                // Si le launcher n'est pas configuré en mode AZauth (Microsoft/hors-ligne),
                // il n'y a pas de profil web associé — on retombe sur les paramètres.
                changePanel('settings');
            }
        });

        // ===== Actions déclenchées depuis le menu contextuel du tray =====
        // (voir app.js : clic droit sur l'icône dans la barre des tâches)
        ipcRenderer.on('tray-launch-instance', async (_, instanceName) => {
            this.startGame(instanceName)
        })

        ipcRenderer.on('tray-open-settings', () => {
            changePanel('settings')
        })

        ipcRenderer.on('tray-logout', async () => {
            // Déconnecte le compte actuellement sélectionné.
            // NOTE : adapte cette logique si ta page settings gère la
            // déconnexion différemment (ex: suppression du compte plutôt
            // que simple désélection). Ici on se contente de désélectionner
            // le compte actif et de recharger l'interface.
            let configClient = await this.db.readData('configClient')
            configClient.account_selected = null
            await this.db.updateData('configClient', configClient)
            location.reload()
        })
        // ===== FIN actions tray =====

    }

    // ===== BANDEAU DE MAINTENANCE (visible pour les comptes whitelistés) =====
    // Si la maintenance est active côté serveur mais que le compte connecté
    // fait partie de la whitelist (voir index.js), on arrive quand même sur
    // le home. Ce bandeau rappelle que la maintenance est en cours pour les
    // joueurs normaux, avec un compte à rebours en direct jusqu'à la fin.
    async checkMaintenanceBanner() {
        try {
            const res = await configModule.GetConfig();
            if (!res.maintenance) return;

            if (res.maintenance_end) {
                const endDate = new Date(res.maintenance_end);
                if (!isNaN(endDate.getTime()) && endDate <= new Date()) return;
            }

            this.renderMaintenanceBanner(res.maintenance_message, res.maintenance_end);
        } catch (err) {
            console.error("Erreur lors de la vérification du bandeau maintenance :", err);
        }
    }

    renderMaintenanceBanner(message, endDateISO) {
        // Évite les doublons si checkMaintenanceBanner est rappelé
        let existing = document.querySelector('.maintenance-banner');
        if (existing) existing.remove();

        const banner = document.createElement('div');
        banner.classList.add('maintenance-banner');

        const plainMessage = message.replace(/<br\s*\/?>/gi, ' ');
        banner.innerHTML = `
            <span class="maintenance-banner-icon">⚠</span>
            <span class="maintenance-banner-text">${plainMessage}</span>
            <span class="maintenance-banner-countdown"></span>
        `;

        document.body.appendChild(banner);

        const countdownEl = banner.querySelector('.maintenance-banner-countdown');

        if (!endDateISO) return;

        const endDate = new Date(endDateISO);
        if (isNaN(endDate.getTime())) return;

        const updateCountdown = () => {
            const diffMs = endDate - new Date();

            if (diffMs <= 0) {
                clearInterval(this.maintenanceBannerInterval);
                banner.remove();
                return;
            }

            const totalSeconds = Math.floor(diffMs / 1000);
            const days = Math.floor(totalSeconds / 86400);
            const hours = Math.floor((totalSeconds % 86400) / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            const pad = (n) => String(n).padStart(2, '0');

            const timeText = `${pad(hours)}h ${pad(minutes)}min ${pad(seconds)}s`;
            const countdownText = days > 0
                ? `Fin dans ${days} jour${days > 1 ? 's' : ''} et ${timeText}`
                : `Fin dans ${timeText}`;

            countdownEl.textContent = countdownText;
        };

        updateCountdown();
        this.maintenanceBannerInterval = setInterval(updateCountdown, 1000);
    }
    // ===== FIN BANDEAU DE MAINTENANCE =====

    async news() {
        let newsContainer = document.querySelector('.news-list');
        let news = await configModule.getNews(this.config).then(res => res).catch(err => false);

        let slides = [];

        if (!news) {
            slides.push({
                title: 'Erreur',
                content: 'Impossible de contacter le serveur des news.<br>Merci de vérifier votre configuration.',
                author: null,
                date: this.getdate(new Date())
            });
        } else if (!news.length) {
            slides.push({
                title: 'Aucune actualité disponible',
                content: 'Vous pourrez suivre ici toutes les news relatives au serveur.',
                author: null,
                date: this.getdate(new Date())
            });
        } else {
            slides = news.map(n => ({
                title: n.title,
                content: n.content.replace(/\n/g, '<br>'),
                author: n.author,
                date: this.getdate(n.publish_date)
            }));
        }

        let current = 0;

        const render = () => {
            const s = slides[current];
            newsContainer.innerHTML = `
                <div class="news-slider">
                    <div class="news-block news-slide">
                        <div class="news-header">
                            <img class="server-status-icon" src="assets/images/icon/icon.png">
                            <div class="header-text">
                                <div class="title">${s.title}</div>
                            </div>
                            <div class="date">
                                <div class="day">${s.date.day}</div>
                                <div class="month">${s.date.month}</div>
                            </div>
                        </div>
                        <div class="news-content">
                            <div class="bbWrapper">
                                <p>${s.content}</p>
                                ${s.author ? `<p class="news-author">Auteur - <span>${s.author}</span></p>` : ''}
                            </div>
                        </div>
                    </div>
                    ${slides.length > 1 ? `
                    <div class="news-slider-controls">
                        <button class="news-arrow news-prev" ${current === 0 ? 'disabled' : ''}>&#8249;</button>
                        <div class="news-dots-wrap">
                            <div class="news-dots">
                                ${slides.map((_, i) => `<span class="news-dot ${i === current ? 'active' : ''}"></span>`).join('')}
                            </div>
                            <div class="news-progress-bar"><div class="news-progress-fill"></div></div>
                        </div>
                        <button class="news-arrow news-next" ${current === slides.length - 1 ? 'disabled' : ''}>&#8250;</button>
                    </div>` : ''}
                </div>`;

            // Relancer l'animation de la barre de progression
            const fillBar = newsContainer.querySelector('.news-progress-fill');
            if (fillBar) {
                fillBar.style.animation = 'none';
                fillBar.offsetHeight; // reflow
                fillBar.style.animation = 'news-progress 12s linear forwards';
            }

            if (slides.length > 1) {
                newsContainer.querySelector('.news-prev')?.addEventListener('click', () => {
                    if (current > 0) { current--; render(); }
                });
                newsContainer.querySelector('.news-next')?.addEventListener('click', () => {
                    if (current < slides.length - 1) { current++; render(); }
                });
                newsContainer.querySelectorAll('.news-dot').forEach((dot, i) => {
                    dot.addEventListener('click', () => { current = i; render(); });
                });
            }

            // Scroll désactivé pour la navigation des news
        };

        render();

        // Auto-slide toutes les 6 secondes avec animation fade
        if (slides.length > 1) {
            let autoSlideTimer = setInterval(() => {
                const next = (current + 1) % slides.length;
                const block = newsContainer.querySelector('.news-block');
                if (!block) return;

                // Animation sortie
                block.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                block.style.opacity = '0';
                block.style.transform = 'translateX(-20px)';

                setTimeout(() => {
                    current = next;
                    render();

                    // Animation entrée
                    const newBlock = newsContainer.querySelector('.news-block');
                    if (newBlock) {
                        newBlock.style.opacity = '0';
                        newBlock.style.transform = 'translateX(20px)';
                        newBlock.style.transition = 'none';
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                newBlock.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                                newBlock.style.opacity = '1';
                                newBlock.style.transform = 'translateX(0)';
                            });
                        });
                    }
                }, 400);
            }, 12000);

            // Reset le timer si l'utilisateur interagit manuellement
            const resetTimer = () => {
                clearInterval(autoSlideTimer);
                autoSlideTimer = setInterval(() => {
                    const next = (current + 1) % slides.length;
                    const block = newsContainer.querySelector('.news-block');
                    if (!block) return;
                    block.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                    block.style.opacity = '0';
                    block.style.transform = 'translateX(-20px)';
                    setTimeout(() => {
                        current = next;
                        render();
                        const newBlock = newsContainer.querySelector('.news-block');
                        if (newBlock) {
                            newBlock.style.opacity = '0';
                            newBlock.style.transform = 'translateX(20px)';
                            newBlock.style.transition = 'none';
                            requestAnimationFrame(() => {
                                requestAnimationFrame(() => {
                                    newBlock.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                                    newBlock.style.opacity = '1';
                                    newBlock.style.transform = 'translateX(0)';
                                });
                            });
                        }
                    }, 400);
                }, 12000);
            };

            newsContainer.addEventListener('click', resetTimer);
        }
    }

    socialLick() {
        let socials = document.querySelectorAll('.social-block, .social-sidebar-btn')

        socials.forEach(social => {
            social.addEventListener('click', e => {
                const url = e.currentTarget.dataset.url
                if (url) shell.openExternal(url)
            })
        });
    }

    // ===== BANDEAU "ÉVALUER LE LAUNCHER" =====
    // Bandeau visible sur le home, avec un bouton pour fermer définitivement
    // (état sauvegardé dans configClient, donc ne réapparaît plus une fois fermé).
    async reviewBanner() {
        // Petit délai : au moment où Home.init() (donc reviewBanner) tourne,
        // startLauncher() (dans launcher.js) n'a pas encore forcément fini de
        // rafraîchir/confirmer account_selected. Sans ce délai, on risque de
        // vérifier le mauvais compte (ou une valeur pas encore à jour).
        await new Promise(resolve => setTimeout(resolve, 1000));

        let configClient = await this.db.readData('configClient');

        const currentAccountId = configClient?.account_selected;
        const dismissedAccounts = configClient?.launcher_config?.review_dismissed_accounts || [];

        // L'état "fermé" est lié au compte connecté, pas au launcher en
        // général — si un joueur laisse un avis avec un compte, ça ne doit
        // pas cacher le bandeau pour un autre compte connecté plus tard.
        if (currentAccountId && dismissedAccounts.includes(currentAccountId)) return;

        // Si le panel n'est plus dans le DOM (cas improbable) ou si on a
        // changé de panel entre-temps, on vérifie qu'il existe toujours.
        const homePanel = document.querySelector('.panel.home');
        if (!homePanel) return;

        const banner = document.createElement('div');
        banner.classList.add('review-banner');
        banner.innerHTML = `
            <span class="review-banner-icon">⭐</span>
            <span class="review-banner-text">Vous appréciez le launcher ? Laissez un avis sur le site !</span>
            <span class="review-banner-btn">Évaluer</span>
            <span class="review-banner-close">✕</span>
        `;

        homePanel.appendChild(banner);

        // Alignement dynamique sur le bouton ⚙️ (settings), plutôt qu'une
        // valeur CSS fixe : la barre du bas est dans un container à largeur
        // limitée qui se centre en plein écran large, donc un simple
        // "right: Xpx" fixe par rapport au bord de la fenêtre ne colle plus
        // au bon endroit selon la taille de la fenêtre.
        const alignBannerToSettingsBtn = () => {
            const sidebar = document.querySelector('.sidebar');
            if (!sidebar) return;
            const rect = sidebar.getBoundingClientRect();
            const rightOffset = window.innerWidth - rect.right;
            banner.style.right = `${rightOffset}px`;
        };

        alignBannerToSettingsBtn();
        window.addEventListener('resize', alignBannerToSettingsBtn);

        const dismissForCurrentAccount = async () => {
            let cfg = await this.db.readData('configClient');
            const accountId = cfg?.account_selected;
            if (!accountId) return;

            if (!cfg.launcher_config) cfg.launcher_config = {};
            if (!cfg.launcher_config.review_dismissed_accounts) cfg.launcher_config.review_dismissed_accounts = [];

            if (!cfg.launcher_config.review_dismissed_accounts.includes(accountId)) {
                cfg.launcher_config.review_dismissed_accounts.push(accountId);
            }
            await this.db.updateData('configClient', cfg);
        };

        banner.querySelector('.review-banner-btn').addEventListener('click', async () => {
            shell.openExternal('https://patateland.wstr.fr/review');
            banner.remove();
            await dismissForCurrentAccount();
        });

        banner.querySelector('.review-banner-close').addEventListener('click', async () => {
            banner.remove();
            await dismissForCurrentAccount();
        });
    }
    // ===== FIN BANDEAU "ÉVALUER LE LAUNCHER" =====

    // ===== ENCART PARTENARIAT (ex: MineStrator) =====
    // Carte affichée sous la liste de news, dans .new-tab. Contrairement au
    // bandeau d'avis, il est PERMANENT : pas de croix, pas de logique de
    // masquage. Le contenu (partner) est en dur ici : si tu gères plusieurs
    // partenaires ou veux changer le texte sans repackager le launcher, tu
    // peux remplacer ce bloc par un fetch vers ta config/API.
    async partnerBanner() {
        const partner = {
            name: 'MineStrator',
            // Logo MineStrator, déjà présent dans tes assets existants
            // (espace encodé en %20 pour éviter tout souci de chemin)
            iconSrc: 'assets/images/svgs/S%20BLANC.svg',
            title: 'Serveur hébergé avec MineStrator !',
            text: `MineStrator, c'est l'hébergeur FR ultra fiable pour tes serveurs Minecraft, moddés, plugins, ou même autres jeux !`,
            code: 'LACRIMO',
            discount: '-10%',
            url: 'https://minestrator.com/a/LACRIMO'
        };

        const newTab = document.querySelector('.new-tab');
        if (!newTab) return;

        // Évite les doublons si partnerBanner() est rappelé
        let existing = document.querySelector('.partner-banner-card');
        if (existing) existing.remove();

        const card = document.createElement('div');
        card.classList.add('partner-banner-card');
        card.innerHTML = `
            <img class="partner-banner-icon" src="${partner.iconSrc}" alt="${partner.name}">
            <div class="partner-banner-body">
                <div class="partner-banner-title">${partner.title}</div>
                <div class="partner-banner-text">
                    ${partner.text}
                    <span class="partner-banner-code-inline">Profite de <b>${partner.discount}</b> avec le code <span class="partner-banner-code">${partner.code}</span></span>
                </div>
            </div>
            <div class="partner-banner-actions">
                <span class="partner-banner-btn">Découvrir ${partner.name} →</span>
            </div>
        `;

        newTab.appendChild(card);

        card.querySelector('.partner-banner-btn').addEventListener('click', () => {
            shell.openExternal(partner.url);
        });
    }
    // ===== FIN ENCART PARTENARIAT =====

    async instancesSelect() {
        let configClient = await this.db.readData('configClient')
        let auth = await this.db.readData('accounts', configClient.account_selected)
        let instancesList = await configModule.getInstanceList()
        let instanceSelect = instancesList.find(i => i.name == configClient?.instance_select) ? configClient?.instance_select : null

        // Transmet la liste des instances au processus principal pour qu'il
        // puisse construire le sous-menu "Jouer" du tray.
        // "Event" s'affiche toujours en dernier, que ce soit dans le popup
        // du sélecteur d'instance ou dans le sous-menu "Jouer" du tray.
        const sortedForTray = [...instancesList].sort((a, b) => {
            const aIsEvent = a.name.trim().toLowerCase() === 'event'
            const bIsEvent = b.name.trim().toLowerCase() === 'event'
            if (aIsEvent && !bIsEvent) return 1
            if (!aIsEvent && bIsEvent) return -1
            return 0
        })
        ipcRenderer.send('update-tray-instances', sortedForTray.map(i => i.name))

        let instanceBTN = document.querySelector('.play-instance')
        let instancePopup = document.querySelector('.instance-popup')
        let instancesListPopup = document.querySelector('.instances-List')
        let instanceCloseBTN = document.querySelector('.close-popup')

        if (instancesList.length === 1) {
            document.querySelector('.instance-select').style.display = 'none'
            instanceBTN.style.paddingRight = '0'
        }

        if (!instanceSelect) {
            let newInstanceSelect = instancesList.find(i => i.whitelistActive == false)
            let configClient = await this.db.readData('configClient')
            configClient.instance_select = newInstanceSelect.name
            instanceSelect = newInstanceSelect.name
            await this.db.updateData('configClient', configClient)
        }

        for (let instance of instancesList) {
            if (instance.whitelistActive) {
                let whitelist = instance.whitelist.find(whitelist => whitelist == auth?.name)
                if (whitelist !== auth?.name) {
                    if (instance.name == newInstanceSelect) {
                        let newInstanceSelect = instancesList.find(i => i.whitelistActive == false)
                        let configClient = await this.db.readData('configClient')
                        configClient.instance_select = newInstanceSelect.name
                        instanceSelect = newInstanceSelect.name
                        setStatus(newInstanceSelect.status)
                        await this.db.updateData('configClient', configClient)
                    }
                }
            } else console.log(`Initializing instance ${instance.name}...`)
                if (instance.name == instanceSelect) {
                    setStatus(instance.status)
                    document.querySelector('.instance-select').textContent = instance.name
                }
        }

        // Bouton JOUER - séparé du sélecteur d'instance
        // On lance toujours l'instance actuellement sélectionnée dans la config.
        // Comme this.activeLaunches est vérifié dans startGame(), cliquer sur
        // JOUER pendant qu'une instance tourne déjà lancera une AUTRE instance
        // (celle sélectionnée à ce moment-là) sans bloquer la première.
        document.querySelector('.play-btn').addEventListener('click', async () => {
            let configClient = await this.db.readData('configClient')
            this.startGame(configClient.instance_select).catch(err => {
                // Filet de sécurité ultime : ne devrait plus jamais se déclencher
                // (toutes les erreurs sont normalement interceptées dans startGame),
                // mais évite un blocage silencieux si un cas imprévu survient.
                console.error('Erreur inattendue au lancement :', err)
                this.activeLaunches.delete(configClient.instance_select); notifyTrayRunning();
            })
        })

        // Sélecteur d'instance - séparé du bouton JOUER
        document.querySelector('.instance-select').addEventListener('click', async e => {
            let configClient = await this.db.readData('configClient')
            let instanceSelect = configClient.instance_select
            let auth = await this.db.readData('accounts', configClient.account_selected)

            if (true) {

        instancesListPopup.innerHTML = ''

        const buildInstanceHTML = (instance, isActive) => {
            const matchKey = Object.keys(instanceDescriptions).find(
                k => k.trim().toLowerCase() === instance.name.trim().toLowerCase()
            )
            const desc = instance.description || instanceDescriptions[matchKey] || "Aucune description disponible pour cette instance."
            const cls = isActive ? 'instance-elements active-instance' : 'instance-elements'
            const running = this.activeLaunches.has(instance.name) ? ' <span class="instance-running-badge">En cours</span>' : ''
            return `
                <div id="${instance.name}" class="${cls}">
                    <span class="instance-name">${instance.name}${running}</span>
                    <div class="instance-info-icon">?</div>
                    <div class="instance-info-tooltip">${desc}</div>
                </div>`
        }

        // "Event" s'affiche toujours en dernier dans le popup, peu importe
        // l'ordre renvoyé par la config.
        const displayList = [...instancesList].sort((a, b) => {
            const aIsEvent = a.name.trim().toLowerCase() === 'event'
            const bIsEvent = b.name.trim().toLowerCase() === 'event'
            if (aIsEvent && !bIsEvent) return 1
            if (!aIsEvent && bIsEvent) return -1
            return 0
        })

        for (let instance of displayList) {
            if (instance.whitelistActive) {
                instance.whitelist.map(whitelist => {
                    if (whitelist == auth?.name) {
                        if (instance.name == instanceSelect) {
                            instancesListPopup.innerHTML += `<div class="glow-container">${buildInstanceHTML(instance, true)}</div>`
                        } else {
                            instancesListPopup.innerHTML += buildInstanceHTML(instance, false)
                        }
                    }
                })
            } else {
                if (instance.name == instanceSelect) {
                    instancesListPopup.innerHTML += buildInstanceHTML(instance, true)
                } else {
                    instancesListPopup.innerHTML += buildInstanceHTML(instance, false)
                }
            }
        }

        instancesListPopup.onclick = async (e) => {
            // Le "?" affiche son info au survol (CSS) ; un clic dessus ou sur
            // le tooltip ne doit jamais sélectionner l'instance en dessous.
            const icon = e.target.closest('.instance-info-icon')
            const tooltip = e.target.closest('.instance-info-tooltip')
            if (icon || tooltip) {
                e.stopPropagation()
                return
            }

            const el = e.target.closest('.instance-elements')
            if (!el) return

            let selected = el.id
            console.log("INSTANCE CLICKED:", selected)

            let configClient = await this.db.readData('configClient')
            configClient.instance_select = selected
            await this.db.updateData('configClient', configClient)

            document.querySelector('.instance-select').textContent = selected

            let instance = instancesList.find(i => i.name == selected)
            if (instance?.status) setStatus(instance.status)

            instancePopup.style.display = 'none'
        }

        instancePopup.style.display = 'flex'
        }
        })

        instanceCloseBTN.addEventListener('click', () => {
            instancePopup.style.display = 'none'
        })
            }

    // startGame prend désormais le nom de l'instance à lancer en paramètre.
    // this.activeLaunches (Map) garde une trace des lancements en cours pour
    // permettre à plusieurs instances de tourner en parallèle sans se marcher
    // dessus. Chaque instance a son propre objet Launch() et ses propres
    // événements identifiés par son nom (utilisé aussi pour la fenêtre de logs).
    // La progression n'est plus affichée dans l'UI (cartes flottantes) mais
    // via des notifications natives OS (Windows/Linux/Mac), voir
    // ipcRenderer.send('game-notification', ...) et app.js.
    async startGame(instanceName) {
        if (this.activeLaunches.has(instanceName)) {
            console.log(`${instanceName} est déjà en cours de lancement ou d'exécution.`)
            return
        }

        let launch = new Launch()
        this.activeLaunches.set(instanceName, launch); notifyTrayRunning();

        // Filet de sécurité : si quoi que ce soit plante pendant la
        // préparation du lancement (config manquante, instance introuvable,
        // etc.), on nettoie l'état au lieu de bloquer l'instance pour toujours.
        let configClient, instanceListAll, authenticator, options
        try {
            configClient = await this.db.readData('configClient')
            instanceListAll = await configModule.getInstanceList()
            authenticator = await this.db.readData('accounts', configClient.account_selected)
            options = instanceListAll.find(i => i.name == instanceName)
            if (!options) throw new Error(`Instance "${instanceName}" introuvable dans la configuration.`)
        } catch (err) {
            console.error('Erreur lors de la préparation du lancement :', err)
            let popupError = new popup()
            popupError.openPopup({
                title: 'Erreur',
                content: err.message || String(err),
                color: 'red',
                options: true
            })
            this.activeLaunches.delete(instanceName); notifyTrayRunning();
            return
        }

        ipcRenderer.send('game-notification', {
            title: 'PatateLand',
            body: `Lancement de ${instanceName}...`
        })

        let opt
        try {
            opt = {
                url: options.url,
                authenticator: authenticator,
                timeout: 10000,
                path: `${await appdata()}/${process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}`,
                instance: options.name,
                version: options.loader.minecraft_version,
                detached: configClient.launcher_config.closeLauncher == "close-all" ? false : true,
                downloadFileMultiple: configClient.launcher_config.download_multi,
                intelEnabledMac: configClient.launcher_config.intelEnabledMac,

                loader: {
                    type: options.loader.loader_type,
                    build: options.loader.loader_version,
                    enable: options.loader.loader_type == 'none' ? false : true
                },

                verify: options.verify,

                ignored: [...options.ignored],

                java: {
                    path: configClient.java_config.java_path,
                },

                JVM_ARGS:  options.jvm_args ? options.jvm_args : [],
                GAME_ARGS: [
                    ...(options.game_args ? options.game_args : []),
                    ...(configClient.game_config.fullscreen ? ['--fullscreen'] : [])
                ],

                screen: {
                    width: configClient.game_config.screen_size.width,
                    height: configClient.game_config.screen_size.height
                },

                memory: {
                    // Math.round (pas juste * 1024) : un -Xmx/-Xms à virgule
                    // (ex: 16281.6M au lieu de 16282M) fait planter la JVM
                    // avec "Could not create the Java Virtual Machine",
                    // quelle que soit la source de la valeur en Go (slider
                    // glissé à la main, ancien profil importé, etc.).
                    min: `${Math.round(configClient.java_config.java_memory.min * 1024)}M`,
                    max: `${Math.round(configClient.java_config.java_memory.max * 1024)}M`
                }
            }

            launch.Launch(opt);
        } catch (err) {
            console.error('Erreur lors du lancement :', err)
            let popupError = new popup()
            popupError.openPopup({
                title: 'Erreur',
                content: err.message || String(err),
                color: 'red',
                options: true
            })
            this.activeLaunches.delete(instanceName); notifyTrayRunning();
            return
        }

        // Repères pour la détection de crash au 'close' (voir plus bas et
        // handleCrash()) : l'heure de lancement sert à ignorer d'éventuels
        // anciens rapports de crash déjà présents dans le dossier, et à ne
        // considérer que ceux générés PENDANT cette session de jeu.
        // Chaque instance a son propre dossier de jeu sous
        // instances/<nomInstance>/ (confirmé par l'arborescence réelle du
        // launcher), donc crash-reports/ s'y trouve aussi.
        const launchedAt = Date.now();
        const crashReportsDir = path.join(opt.path, 'instances', options.name, 'crash-reports');

        ipcRenderer.send('main-window-progress-load')

        // Ouvre la fenêtre de logs pour cette instance si elle n'est pas
        // déjà ouverte. Respecte show_console pour l'ouverture "normale"
        // (déclenchée par le premier event 'data', voir plus bas), mais on
        // la force à s'ouvrir en cas d'ERREUR (voir 'error' ci-dessous) ou
        // de VRAI crash confirmé (voir handleCrash — pas juste un code de
        // sortie non-nul, voir NOTE plus bas dans 'close').
        let logWindowOpened = false;
        const ensureLogWindowOpen = () => {
            if (logWindowOpened) return;
            logWindowOpened = true;
            ipcRenderer.send('log-window-open', instanceName, `PatateLand - ${instanceName}`);
        };

        launch.on('extract', extract => {
            ipcRenderer.send('main-window-progress-load')
            console.log(instanceName, extract);
        });

        launch.on('progress', (progress, size) => {
            ipcRenderer.send('main-window-progress', { progress, size })
            ipcRenderer.send('log-send', instanceName, `Téléchargement : ${((progress / size) * 100).toFixed(0)}%`);
        });

        launch.on('check', (progress, size) => {
            ipcRenderer.send('main-window-progress', { progress, size })
        });

        launch.on('estimated', (time) => {
            let hours = Math.floor(time / 3600);
            let minutes = Math.floor((time - hours * 3600) / 60);
            let seconds = Math.floor(time - hours * 3600 - minutes * 60);
            console.log(instanceName, `${hours}h ${minutes}m ${seconds}s`);
        })

        launch.on('speed', (speed) => {
            console.log(instanceName, `${(speed / 1067008).toFixed(2)} Mb/s`)
        })

        launch.on('patch', patch => {
            console.log(instanceName, patch);
            ipcRenderer.send('main-window-progress-load')
        });

        let readyNotified = false;
        let serversInjected = false;
        let windowAutoHidden = false;
        launch.on('data', (e) => {
            // Injecte le serveur PatateLand dans le servers.dat de cette
            // instance UNE SEULE FOIS, ici plutôt qu'avant launch.Launch(opt) :
            // le téléchargement/la vérification des fichiers de l'instance
            // (qui peut inclure un servers.dat livré côté serveur, cf. config
            // WinSCP) se fait entre l'appel à Launch() et ce premier event
            // 'data'. Injecter avant Launch() serait donc écrasé par ce
            // téléchargement. Le jeu ne lit servers.dat qu'à l'ouverture de
            // l'écran multijoueur, donc l'injecter ici (dès que le process
            // Minecraft a démarré) reste largement à temps.
            if (!serversInjected) {
                serversInjected = true;
                const instancePath = path.join(opt.path, 'instances', options.name);
                injectServer(instancePath, instanceName);
            }

            // BUG CORRIGÉ : ce bloc tournait sur CHAQUE ligne de log (donc
            // potentiellement des dizaines de fois par seconde pendant que
            // le jeu tourne), sans aucun garde-fou. Résultat : si l'utilisateur
            // rouvrait le launcher manuellement pendant une partie, la ligne
            // de log suivante le re-masquait immédiatement. Le flag
            // windowAutoHidden garantit que ça ne se déclenche qu'une seule
            // fois par lancement, comme readyNotified/serversInjected.
            if (!windowAutoHidden) {
                windowAutoHidden = true;
                const closeMode = configClient.launcher_config.closeLauncher;
                if (closeMode == 'close-launcher') {
                    ipcRenderer.send("main-window-minimize");
                } else if (closeMode == 'close-window') {
                    ipcRenderer.send("main-window-hide");
                }
            }
            new logger('Minecraft', '#36b030');
            ipcRenderer.send('main-window-progress-load')
            // Ouverture "normale" de la fenêtre de logs, seulement si
            // activée dans les settings (comportement inchangé).
            if (!logWindowOpened && configClient.game_config?.show_console !== false) {
                ensureLogWindowOpen();
                ipcRenderer.send('log-status', instanceName, 'running');
            }
            // Le jeu a réellement démarré : on prévient une seule fois via
            // notification native que l'instance est prête.
            if (!readyNotified) {
                readyNotified = true
                ipcRenderer.send('game-notification', {
                    title: 'PatateLand',
                    body: `${instanceName} a démarré !`
                })
            }
            const line = typeof e === 'string' ? e : JSON.stringify(e);
            ipcRenderer.send('log-send', instanceName, line);
            console.log(instanceName, e);
        })

        launch.on('close', code => {
            if (['close-launcher', 'close-window'].includes(configClient.launcher_config.closeLauncher)) {
                ipcRenderer.send("main-window-show")
            };
            ipcRenderer.send('main-window-progress-reset')
            ipcRenderer.send('log-status', instanceName, 'closed');
            new logger(pkg.name, '#7289da');
            console.log(instanceName, 'Close - exit code:', code, '(type:', typeof code, ')');
            this.activeLaunches.delete(instanceName); notifyTrayRunning();

            // Code de sortie 0 = fermeture normale. Tout le reste (crash,
            // kill du processus, JVM plantée...) déclenche une recherche du
            // rapport de crash le plus récent généré depuis le lancement.
            // NOTE : certains packs/loaders renvoient parfois un code non-nul
            // même sur une fermeture parfaitement normale (comportement
            // propre à Forge/JVM selon la config) — on ne force donc PAS
            // l'ouverture de la console ici sur la simple base du code de
            // sortie. C'est handleCrash() qui décide, et seulement s'il
            // trouve un VRAI fichier de crash-report (voir plus bas).
            if (code !== 0) {
                console.log(instanceName, '[DIAGNOSTIC] code !== 0, entrée dans la détection crash. code =', code);
                this.handleCrash(instanceName, crashReportsDir, launchedAt, authenticator?.name, ensureLogWindowOpen);
            } else {
                console.log(instanceName, '[DIAGNOSTIC] code === 0, fermeture normale, pas de vérification crash.');
            }
        });

        launch.on('error', err => {
            // Erreur survenant potentiellement AVANT tout event 'data' (ex:
            // téléchargement échoué, Java introuvable...) : on force donc
            // l'ouverture de la fenêtre de logs pour que le détail de
            // l'erreur (envoyé juste après via 'log-send') soit visible
            // quelque part, et pas seulement dans le popup ci-dessous.
            ensureLogWindowOpen();

            let popupError = new popup()

            // err.error n'est pas toujours présent selon la forme exacte de
            // l'erreur renvoyée par minecraft-java-core (constaté notamment
            // sur Mac où l'erreur peut arriver sous une autre forme) : sans
            // ce filet, le popup affichait littéralement le texte "undefined".
            const errorMessage = err?.error
                || err?.message
                || (typeof err === 'string' ? err : null)
                || (() => { try { return JSON.stringify(err) } catch { return null } })()
                || 'Erreur inconnue lors du lancement. Consulte la console de jeu pour plus de détails.'

            popupError.openPopup({
                title: 'Erreur',
                content: errorMessage,
                color: 'red',
                options: true
            })

            ipcRenderer.send('game-notification', {
                title: 'PatateLand',
                body: `Erreur au lancement de ${instanceName}.`
            })

            if (['close-launcher', 'close-window'].includes(configClient.launcher_config.closeLauncher)) {
                ipcRenderer.send("main-window-show")
            };
            ipcRenderer.send('main-window-progress-reset')
            ipcRenderer.send('log-status', instanceName, 'error');
            ipcRenderer.send('log-send', instanceName, `ERREUR: ${JSON.stringify(err)}`);
            new logger(pkg.name, '#7289da');
            console.log(instanceName, err);
            this.activeLaunches.delete(instanceName); notifyTrayRunning();
        });
    }

    // ===== DÉTECTION & LECTURE DU RAPPORT DE CRASH =====
    // Cherche le fichier crash-*.txt le plus récent créé depuis le lancement
    // (avec 5s de marge pour l'écriture disque), puis l'envoie à la fenêtre
    // de logs de cette instance via le canal 'log-send' existant, encadré de
    // marqueurs que log.html sait reconnaître et afficher comme un bloc
    // dédié (voir processIncomingLine/renderCrashReport dans log.html).
    // On ne bascule le statut sur "crashed" ET on n'ouvre la console
    // (ensureLogWindowOpen) QUE si un rapport a bien été trouvé — pas sur la
    // simple base d'un code de sortie non-nul (certains packs/loaders en
    // renvoient parfois un même sur une fermeture normale, ce qui ouvrait
    // la console à tort à chaque fermeture pour certains utilisateurs).
    async handleCrash(instanceName, crashReportsDir, launchedAt, playerName, ensureLogWindowOpen) {
        console.log(instanceName, '[DIAGNOSTIC] handleCrash appelé. crashReportsDir:', crashReportsDir);
        try {
            if (!fs.existsSync(crashReportsDir)) {
                console.log(instanceName, '[DIAGNOSTIC] Dossier crash-reports introuvable -> pas de crash, aucune action.');
                // Pas de dossier crash-reports du tout : très probablement
                // une fermeture normale avec juste un code de sortie
                // inhabituel, pas un vrai crash. On ne force rien, on ne
                // log même pas (silence complet pour ne pas polluer une
                // console qui n'existe peut-être pas).
                return;
            }

            const allFiles = fs.readdirSync(crashReportsDir);
            console.log(instanceName, '[DIAGNOSTIC] Fichiers dans crash-reports:', allFiles);

            const files = allFiles
                .filter(f => f.toLowerCase().endsWith('.txt'))
                .map(f => {
                    const fullPath = path.join(crashReportsDir, f);
                    return { fullPath, mtime: fs.statSync(fullPath).mtimeMs };
                })
                // Marge de 5s : l'écriture du fichier peut survenir juste
                // avant le timestamp exact considéré comme "lancement".
                .filter(f => f.mtime >= launchedAt - 5000)
                .sort((a, b) => b.mtime - a.mtime);

            console.log(instanceName, '[DIAGNOSTIC] launchedAt:', launchedAt, new Date(launchedAt).toLocaleTimeString(),
                '- Fichiers récents trouvés (après filtre 5s):', files.length, files.map(f => f.fullPath));

            if (!files.length) {
                console.log(instanceName, '[DIAGNOSTIC] Aucun fichier récent -> pas de crash, aucune action.');
                // Toujours aucune preuve concrète de crash -> pareil, on ne
                // force pas l'ouverture de la console pour un simple code
                // de sortie inhabituel sans rapport derrière.
                return;
            }

            console.log(instanceName, '[DIAGNOSTIC] Fichier de crash trouvé -> ouverture de la console.');

            // À partir d'ici : un VRAI rapport de crash a été trouvé, donc
            // c'est un vrai crash. On peut ouvrir la console en confiance.
            ensureLogWindowOpen();

            const report = files[0];
            const content = fs.readFileSync(report.fullPath, 'utf-8');

            ipcRenderer.send('log-status', instanceName, 'crashed');
            ipcRenderer.send('log-send', instanceName,
                `===CRASH_REPORT===\nPATH:${report.fullPath}\n${content}\n===END_CRASH_REPORT===`);

            // Envoi Discord non-bloquant : une erreur réseau ou un webhook
            // mal configuré ne doit jamais empêcher l'affichage local du
            // rapport (déjà fait juste au-dessus), d'où le try/catch dédié
            // à l'intérieur de sendCrashReportToDiscord elle-même.
            this.sendCrashReportToDiscord(instanceName, playerName, report.fullPath, content);
        } catch (err) {
            console.error('Erreur lors de la lecture du rapport de crash :', err);
        }
    }

    // Envoie le rapport de crash sur Discord via un webhook, avec un embed
    // (joueur, instance, date) et le fichier .txt en pièce jointe. fetch et
    // FormData sont utilisés tels quels : ce sont des API du navigateur
    // (Chromium), disponibles nativement dans le renderer Electron, pas
    // besoin d'installer de lib supplémentaire (node-fetch, axios...).
    async sendCrashReportToDiscord(instanceName, playerName, reportPath, content) {
        if (!CRASH_REPORT_DISCORD_WEBHOOK) return;

        // Option désactivée par défaut (voir settings > LAUNCHER > Rapports
        // de crash) : sans consentement explicite de l'utilisateur, on ne
        // tente même pas la requête réseau.
        const cfg = await this.db.readData('configClient');
        if (!cfg?.launcher_config?.send_crash_reports) return;

        try {
            const fileName = path.basename(reportPath);

            const payload = {
                embeds: [{
                    title: `💥 Crash détecté — ${instanceName}`,
                    color: 0xe74c3c,
                    fields: [
                        { name: 'Joueur', value: playerName || 'Inconnu', inline: true },
                        { name: 'Instance', value: instanceName, inline: true },
                        { name: 'Date', value: new Date().toLocaleString('fr-FR'), inline: false }
                    ]
                }]
            };

            const formData = new FormData();
            formData.append('payload_json', JSON.stringify(payload));
            formData.append('files[0]', new Blob([content], { type: 'text/plain' }), fileName);

            const res = await fetch(CRASH_REPORT_DISCORD_WEBHOOK, {
                method: 'POST',
                body: formData
            });

            if (!res.ok) {
                console.error('Webhook Discord (crash report) a répondu', res.status, await res.text().catch(() => ''));
            }
        } catch (err) {
            console.error('Erreur lors de l\'envoi du crash report sur Discord :', err);
        }
    }
    // ===== FIN DÉTECTION & LECTURE DU RAPPORT DE CRASH =====

    getdate(e) {
        let date = new Date(e)
        let year = date.getFullYear()
        let month = date.getMonth() + 1
        let day = date.getDate()
        let allMonth = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
        return { year: year, month: allMonth[month - 1], day: day }
    }
}

export default Home;