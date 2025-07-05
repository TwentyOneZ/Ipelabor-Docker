const { Boom } = require('@hapi/boom');
const { DisconnectReason } = require('@whiskeysockets/baileys');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const mqtt = require('mqtt');
const P = require('pino');
const mysql = require('mysql2/promise');
const fs = require('fs');
const ini = require('ini');
const path = require('path');

// ==================== CONFIG ====================
const configPath = path.join(__dirname, 'config.ini');
if (!fs.existsSync(configPath)) {
    logger.error('❌ Arquivo config.ini não encontrado.');
    process.exit(1);
}
const config = ini.parse(fs.readFileSync(configPath, 'utf-8'));

const dbConfig = config.mysql;
const mqttBroker = config.mqtt?.broker || 'mqtt://localhost:1883';
const mqttOptions = {};
if (config.mqtt?.username) mqttOptions.username = config.mqtt.username;
if (config.mqtt?.password) mqttOptions.password = config.mqtt.password;

const settings = config.settings || {};
const finalizationEmojis = (settings.finalizationEmojis || '').split(',').map(e => e.trim());
const maxCacheMessages = Number.isNaN(parseInt(settings.maxCacheMessages)) ? 500 : parseInt(settings.maxCacheMessages);

const branches = {};
Object.keys(config.branches).forEach(branch => {
    branches[branch] = config.branches[branch].split(',').map(id => id.trim());
});
const branchNames = {};
Object.keys(config.branch_names).forEach(branch => {
    branchNames[branch] = config.branch_names[branch];
});
const topicMessagesSuffix = config.topics?.messages || '/painel/messages';
const topicReactionsSuffix = config.topics?.reactions || '/painel/reactions';

const roomNames = {};
Object.keys(config.rooms).forEach(chatId => {
    roomNames[chatId] = config.rooms[chatId];
});
const roomEmojis = {};
Object.keys(config.emojis).forEach(chatId => {
    roomEmojis[chatId] = config.emojis[chatId];
});

// ==================== LOG COM ROTAÇÃO ====================
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);
const logFileName = `wa-logs-${new Date().toISOString().slice(0, 10)}.txt`;
const logFilePath = path.join(logsDir, logFileName);

const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination(logFilePath));
logger.level = 'info';

// ==================== VARIÁVEIS ====================
const messageCache = new Map();

let mqttConnected = false;
let mqttConnecting = false;
let waConnected = false;
let waConnecting = false;

let mqttClient = null;
let sock = null;
let pool = null;

// ==================== FUNÇÕES ====================
function getBranchByChatId(chatId) {
    for (const [branch, chatList] of Object.entries(branches)) {
        if (chatList.includes(chatId)) {
            return branch;
        }
    }
    return null;
}

function getTopicsByBranch(branch) {
    const branchName = branchNames[branch] || branch;
    return {
        topicMessages: `${branchName}${topicMessagesSuffix}`,
        topicReactions: `${branchName}${topicReactionsSuffix}`
    };
}

// ==================== MYSQL ====================
async function connectMySQL() {
    pool = mysql.createPool({
        host: dbConfig.host,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database,
        waitForConnections: true,
        connectionLimit: 10
    });

    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            msgId VARCHAR(255) PRIMARY KEY,
            chatId VARCHAR(255),
            branch VARCHAR(255),
            text TEXT,
            fromMe BOOLEAN,
            participant VARCHAR(255),
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS atendimentos (
        msgId VARCHAR(255) PRIMARY KEY,
        paciente VARCHAR(255),
        empresa VARCHAR(255),
        sala VARCHAR(255),
        branch VARCHAR(255),
        data DATE,
        hora_inicio TIME,
        hora_fim TIME,
        duracao VARCHAR(50),
        caller VARCHAR(255)
        )
    `);

    const [rows] = await pool.query(`SELECT * FROM messages ORDER BY timestamp DESC LIMIT ${maxCacheMessages}`);
    rows.reverse().forEach(row => {
        messageCache.set(row.msgId, {
            text: row.text,
            chatId: row.chatId,
            fromMe: row.fromMe,
            participant: row.participant
        });
    });
}

// ==================== MQTT ====================
async function connectMQTT() {
    if (mqttConnecting) return;
    mqttConnecting = true;

    return new Promise((resolve) => {
        const client = mqtt.connect(mqttBroker, mqttOptions);

        client.on('connect', () => {
            mqttConnected = true;
            mqttConnecting = false;
            resolve(client);
        });

        const handleDisconnect = () => {
            mqttConnected = false;
            mqttClient = null;
            mqttConnecting = false;
            setTimeout(() => connectMQTT().then(c => mqttClient = c), 10000);
        };

        client.on('error', (err) => { client.end(); handleDisconnect(err.message); });
        client.on('offline', handleDisconnect);
        client.on('close', handleDisconnect);
    });
}

// ==================== WHATSAPP ====================
async function connectWhatsApp() {
    if (waConnecting) return;
    waConnecting = true;

    try {
        const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: true,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            generateHighQualityLinkPreview: true
        });

        sock.ev.process(async (events) => {
            if (events['connection.update']) {
                const { connection, lastDisconnect, qr } = events['connection.update'];
                if (qr) logger.info('📲 Escaneie o QR Code');
                if (connection === 'open') {
                    waConnected = true;
                    waConnecting = false;
                }
                if (connection === 'close') {
                    waConnected = false;
                    waConnecting = false;
                    const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
                    if (statusCode !== DisconnectReason.loggedOut) {
                        setTimeout(() => connectWhatsApp(), 10000);
                    }
                }
            }
            if (events['creds.update']) await saveCreds();
            if (events['messages.upsert']) await handleIncomingMessages(events['messages.upsert']);
        });
    } catch (err) {
        waConnected = false;
        waConnecting = false;
        setTimeout(() => connectWhatsApp(), 10000);
    }
}

// ==================== PROCESSAMENTO ====================
async function handleIncomingMessages(upsert) {
    if (upsert.type !== 'notify') return;

    for (const msg of upsert.messages) {
        const msgId = msg.key.id;
        const chatId = msg.key.remoteJid;
        const branch = getBranchByChatId(chatId);
        if (!branch) return;

        const topics = getTopicsByBranch(branch);

        let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (msg.message?.imageMessage?.caption) text = msg.message.imageMessage.caption;

        if (text) {
            messageCache.set(msgId, {
                text,
                chatId,
                fromMe: msg.key.fromMe || false,
                participant: msg.key.participant || msg.key.remoteJid
            });

            await pool.execute(`
                INSERT IGNORE INTO messages (msgId, chatId, branch, text, fromMe, participant)
                VALUES (?, ?, ?, ?, ?, ?)`,
                [msgId, chatId, branch, text, msg.key.fromMe || false, msg.key.participant || msg.key.remoteJid]
            );

            mqttClient.publish(topics.topicMessages, JSON.stringify({
                text,
                chatId,
                branch,
                sender: msg.pushName,
                encoding: 'utf-8'
            }));
        }

        if (msg.message?.reactionMessage) {
            const reaction = msg.message.reactionMessage;
            const emoji = reaction.text;
            const reactedMsgId = reaction.key.id;
            const reactedChatId = reaction.key.remoteJid;

            const cachedData = messageCache.get(reactedMsgId);
            const originalText = cachedData?.text || '[mensagem não encontrada]';
            const reactedBy = msg.pushName || 'Usuário';

            mqttClient.publish(topics.topicReactions, JSON.stringify({
                reaction: emoji,
                originalMessage: originalText,
                reactedBy,
                chatId: reactedChatId,
                branch,
                encoding: 'utf-8'
            }));

            if (emoji === '❤️') {
                const sala = roomNames[reactedChatId] || reactedChatId;
                const markerEmoji = roomEmojis[reactedChatId] || '✅';

                await pool.execute(`
                    INSERT INTO atendimentos (msgId, paciente, empresa, sala, branch, data, hora_inicio)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                    hora_inicio = VALUES(hora_inicio),
                    hora_fim = NULL,
                    duracao = NULL,
                    branch = VALUES(branch)
                `, [
                    reactedMsgId,
                    originalText.trim(),
                    '',
                    sala,
                    branch,
                    new Date().toISOString().slice(0, 10),
                    new Date().toTimeString().slice(0, 8)
                ]);

                const searchTerm = originalText.split(" ").slice(0, 2).join(" ").toLowerCase();

                // 🔄 Remove emoji anterior na sala
                for (const [cachedMsgId, cachedData] of messageCache.entries()) {
                    if (cachedData.chatId === reactedChatId) {
                        await sock.sendMessage(reactedChatId, {
                            react: {
                                text: '',
                                key: {
                                    remoteJid: reactedChatId,
                                    id: cachedMsgId,
                                    fromMe: cachedData.fromMe,
                                    participant: cachedData.participant
                                }
                            }
                        });
                    }
                }

                // ✅ Marca mensagens encontradas
                for (const [cachedMsgId, cachedData] of messageCache.entries()) {
                    if (!cachedData || typeof cachedData.text !== 'string') continue;
                    const otherChatId = cachedData.chatId;
                    const otherBranch = getBranchByChatId(otherChatId);
                    if (otherBranch === branch && cachedData.text.toLowerCase().includes(searchTerm)) {
                        const emojiToSend = roomEmojis[otherChatId] || markerEmoji;
                        await sock.sendMessage(otherChatId, {
                            react: {
                                text: emojiToSend,
                                key: {
                                    remoteJid: otherChatId,
                                    id: cachedMsgId,
                                    fromMe: cachedData.fromMe,
                                    participant: cachedData.participant
                                }
                            }
                        });
                    }
                }
            }
        }
    }
}

// ==================== START ====================
(async () => {
    await connectMySQL();
    mqttClient = await connectMQTT();
    connectWhatsApp();
})();
