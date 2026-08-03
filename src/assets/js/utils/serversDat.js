/**
 * serversDat.js
 *
 * Écrit/injecte automatiquement le serveur PatateLand dans le fichier
 * servers.dat (liste multijoueur) de chaque instance, sans dépendre
 * d'aucune librairie NBT externe (writer + reader NBT minimal en JS pur).
 *
 * servers.dat est un fichier NBT NON compressé (contrairement à level.dat
 * qui est gzip), structure : big-endian, TAG_Compound racine (nom vide)
 * contenant une TAG_List "servers" de TAG_Compound.
 *
 * Utilisation (dans home.js, juste avant launch.Launch(opt)) :
 *
 *   const { injectServer } = require('./utils/serversDat.js');
 *   const instancePath = path.join(opt.path, 'instances', options.name);
 *   injectServer(instancePath, instanceName);
 */

const fs = require('fs');
const path = require('path');

// ===== Table des serveurs par instance =====
// Ajoute/modifie ici si de nouvelles instances doivent pointer vers un
// serveur multijoueur différent. Une instance absente de cette table est
// simplement ignorée (aucune injection).
const SERVERS_CONFIG = {
    'Opti':  { ip: 'patateland.minesr.com',      name: 'PatateLand' },
    'Extra': { ip: 'patateland.minesr.com',      name: 'PatateLand' },
    'Event': { ip: 'patateland-event.mine.fun',  name: 'PatateLand - Event' }
};

// ===== Types de tags NBT =====
const TAG = {
    End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
    ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12
};

// ============================================================
// ================        NBT WRITER        ==================
// ============================================================

class NBTWriter {
    constructor() {
        this.chunks = [];
    }

    _push(buf) { this.chunks.push(buf); }

    writeByte(value) {
        const b = Buffer.alloc(1);
        b.writeInt8(value, 0);
        this._push(b);
    }

    writeShort(value) {
        const b = Buffer.alloc(2);
        b.writeInt16BE(value, 0);
        this._push(b);
    }

    writeInt(value) {
        const b = Buffer.alloc(4);
        b.writeInt32BE(value, 0);
        this._push(b);
    }

    writeString(str) {
        const strBuf = Buffer.from(String(str), 'utf8');
        this.writeShort(strBuf.length);
        this._push(strBuf);
    }

    toBuffer() {
        return Buffer.concat(this.chunks);
    }
}

// Écrit la payload d'un compound : liste de {type, name, value}, puis TAG_End
function writeCompoundPayload(writer, fields) {
    for (const field of fields) {
        writer.writeByte(field.type);
        writer.writeString(field.name);
        writeFieldValue(writer, field.type, field.value);
    }
    writer.writeByte(TAG.End);
}

function writeFieldValue(writer, type, value) {
    switch (type) {
        case TAG.Byte:
            writer.writeByte(value);
            break;
        case TAG.Short:
            writer.writeShort(value);
            break;
        case TAG.Int:
            writer.writeInt(value);
            break;
        case TAG.String:
            writer.writeString(value);
            break;
        case TAG.Compound:
            writeCompoundPayload(writer, value);
            break;
        case TAG.List: {
            const { itemType, items } = value;
            writer.writeByte(itemType);
            writer.writeInt(items.length);
            for (const item of items) {
                if (itemType === TAG.Compound) {
                    writeCompoundPayload(writer, item);
                } else {
                    writeFieldValue(writer, itemType, item);
                }
            }
            break;
        }
        default:
            throw new Error(`[serversDat] Type NBT non supporté en écriture : ${type}`);
    }
}

// Construit le buffer complet du fichier servers.dat à partir d'une liste
// de serveurs [{ip, name, hidden?, acceptTextures?}, ...]
function buildServersDatBuffer(servers) {
    const writer = new NBTWriter();

    // Racine : TAG_Compound, nom vide
    writer.writeByte(TAG.Compound);
    writer.writeString('');

    writeCompoundPayload(writer, [
        {
            type: TAG.List,
            name: 'servers',
            value: {
                itemType: TAG.Compound,
                items: servers.map(s => {
                    const fields = [
                        { type: TAG.String, name: 'ip', value: s.ip },
                        { type: TAG.String, name: 'name', value: s.name }
                    ];
                    if (typeof s.hidden === 'boolean') {
                        fields.push({ type: TAG.Byte, name: 'hidden', value: s.hidden ? 1 : 0 });
                    }
                    if (typeof s.acceptTextures === 'number') {
                        fields.push({ type: TAG.Byte, name: 'acceptTextures', value: s.acceptTextures });
                    }
                    return fields;
                })
            }
        }
    ]);

    return writer.toBuffer();
}

// ============================================================
// ================        NBT READER         ==================
// ============================================================
// Reader minimal, utilisé uniquement pour relire un servers.dat existant
// (afin de fusionner/dédupliquer au lieu d'écraser les serveurs déjà
// ajoutés manuellement par le joueur).

class NBTReader {
    constructor(buffer) {
        this.buffer = buffer;
        this.offset = 0;
    }

    readByte() {
        const v = this.buffer.readInt8(this.offset);
        this.offset += 1;
        return v;
    }

    readShort() {
        const v = this.buffer.readInt16BE(this.offset);
        this.offset += 2;
        return v;
    }

    readInt() {
        const v = this.buffer.readInt32BE(this.offset);
        this.offset += 4;
        return v;
    }

    readLong() {
        const v = this.buffer.readBigInt64BE(this.offset);
        this.offset += 8;
        return v;
    }

    readFloat() {
        const v = this.buffer.readFloatBE(this.offset);
        this.offset += 4;
        return v;
    }

    readDouble() {
        const v = this.buffer.readDoubleBE(this.offset);
        this.offset += 8;
        return v;
    }

    readString() {
        const len = this.readShort();
        const str = this.buffer.toString('utf8', this.offset, this.offset + len);
        this.offset += len;
        return str;
    }

    readByteArray() {
        const len = this.readInt();
        const arr = this.buffer.slice(this.offset, this.offset + len);
        this.offset += len;
        return arr;
    }

    readIntArray() {
        const len = this.readInt();
        const arr = [];
        for (let i = 0; i < len; i++) arr.push(this.readInt());
        return arr;
    }

    readLongArray() {
        const len = this.readInt();
        const arr = [];
        for (let i = 0; i < len; i++) arr.push(this.readLong());
        return arr;
    }

    readPayload(type) {
        switch (type) {
            case TAG.Byte: return this.readByte();
            case TAG.Short: return this.readShort();
            case TAG.Int: return this.readInt();
            case TAG.Long: return this.readLong();
            case TAG.Float: return this.readFloat();
            case TAG.Double: return this.readDouble();
            case TAG.ByteArray: return this.readByteArray();
            case TAG.String: return this.readString();
            case TAG.List: return this.readList();
            case TAG.Compound: return this.readCompound();
            case TAG.IntArray: return this.readIntArray();
            case TAG.LongArray: return this.readLongArray();
            default:
                throw new Error(`[serversDat] Type NBT inconnu en lecture : ${type}`);
        }
    }

    readList() {
        const itemType = this.readByte();
        const length = this.readInt();
        const items = [];
        for (let i = 0; i < length; i++) items.push(this.readPayload(itemType));
        return { itemType, items };
    }

    readCompound() {
        const obj = {};
        // Boucle jusqu'à TAG_End
        while (true) {
            const type = this.readByte();
            if (type === TAG.End) break;
            const name = this.readString();
            obj[name] = this.readPayload(type);
        }
        return obj;
    }

    readRoot() {
        const type = this.readByte();
        if (type !== TAG.Compound) {
            throw new Error('[serversDat] Le tag racine n\'est pas un TAG_Compound');
        }
        this.readString(); // nom de la racine, généralement vide
        return this.readCompound();
    }
}

// ============================================================
// ================    LOGIQUE D'INJECTION    ==================
// ============================================================

// Relit un servers.dat existant et renvoie sa liste de serveurs sous forme
// simple [{ip, name, hidden, acceptTextures}, ...]. Renvoie [] si le fichier
// n'existe pas ou est illisible/corrompu (on le régénère alors proprement).
function readExistingServers(serversDatPath) {
    if (!fs.existsSync(serversDatPath)) return [];

    try {
        const buffer = fs.readFileSync(serversDatPath);
        const reader = new NBTReader(buffer);
        const root = reader.readRoot();
        const serversList = root.servers;

        if (!serversList || !Array.isArray(serversList.items)) return [];

        return serversList.items.map(item => ({
            ip: item.ip,
            name: item.name,
            hidden: item.hidden === 1,
            acceptTextures: typeof item.acceptTextures === 'number' ? item.acceptTextures : undefined
        }));
    } catch (err) {
        console.error('[serversDat] servers.dat existant illisible, il sera recréé :', err.message);
        return [];
    }
}

/**
 * Injecte le serveur PatateLand correspondant à l'instance donnée dans le
 * servers.dat de cette instance. Ne touche pas aux autres serveurs déjà
 * présents (ajoutés manuellement par le joueur) ; évite juste les doublons
 * sur notre propre IP et place notre serveur en première position.
 *
 * @param {string} instancePath - dossier .minecraft de l'instance (là où
 *   sera lu/écrit le servers.dat), typiquement :
 *   path.join(opt.path, 'instances', options.name)
 * @param {string} instanceName - nom de l'instance (clé de SERVERS_CONFIG)
 */
function injectServer(instancePath, instanceName) {
    const target = SERVERS_CONFIG[instanceName];
    if (!target) return; // pas de serveur configuré pour cette instance

    try {
        if (!fs.existsSync(instancePath)) {
            fs.mkdirSync(instancePath, { recursive: true });
        }

        const serversDatPath = path.join(instancePath, 'servers.dat');

        let servers = readExistingServers(serversDatPath);

        // Retire toute entrée existante pointant déjà vers notre IP
        // (évite les doublons si le launcher est relancé plusieurs fois)
        servers = servers.filter(s => s.ip !== target.ip);

        // Injecte notre serveur en tête de liste
        servers.unshift({ ip: target.ip, name: target.name });

        const buffer = buildServersDatBuffer(servers);
        fs.writeFileSync(serversDatPath, buffer);

        console.log(`[serversDat] Serveur "${target.name}" (${target.ip}) injecté pour l'instance "${instanceName}".`);
    } catch (err) {
        // On ne bloque jamais le lancement du jeu pour ça : au pire, le
        // joueur devra ajouter le serveur à la main.
        console.error(`[serversDat] Échec de l'injection pour l'instance "${instanceName}" :`, err.message);
    }
}

export { injectServer, SERVERS_CONFIG };