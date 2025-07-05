// whatsappClient.js

const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const logger = require('./logger');
const { Boom } = require('@hapi/boom');
const { DisconnectReason } = require('@whiskeysockets/baileys');
const { handleIncomingMessages } = require('./handlers');

let sock = null;

/**
 * Inicia a conexão com o WhatsApp e armazena
 * a instância em `sock` para uso global.
 */
async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
  const { version, isLatest } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
  });

  logger.info(`✅ WhatsApp iniciado (v${version.join('.')}, isLatest=${isLatest})`);

  sock.ev.process(async events => {
    // Atualização da conexão
    if (events['connection.update']) {
      const { connection, lastDisconnect, qr } = events['connection.update'];
      if (qr) logger.info('📲 Escaneie o QR Code no app');
      if (connection === 'open') {
        logger.info('✅ WhatsApp conectado!');
      }
      if (connection === 'close') {
        logger.info('❌ WhatsApp desconectado:', lastDisconnect?.error?.message);
        const shouldReconnect =
          lastDisconnect?.error instanceof Boom &&
          lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          logger.info('🔄 Reconectando em 10s...');
          setTimeout(connectWhatsApp, 10000);
        } else {
          logger.info('⚠️ Sessão expirada. Escaneie novamente o QR Code.');
        }
      }
    }

    // Credenciais atualizadas
    if (events['creds.update']) {
      await saveCreds();
    }

    // Mensagens recebidas
    if (events['messages.upsert']) {
        // <<< PASSAR sock AQUI >>> 
        await handleIncomingMessages(events['messages.upsert'], sock);
      }
  });

  return sock;
}

/**
 * Retorna a instância do socket (depois de connectWhatsApp).
 */
function getSock() {
  if (!sock) {
    throw new Error('⚠️ WhatsApp não conectado. Chame connectWhatsApp() primeiro.');
  }
  return sock;
}

/**
 * (Opcional) Permite definir manualmente a instância do socket.
 */
function setSock(instance) {
  sock = instance;
}

module.exports = {
  connectWhatsApp,
  getSock,
  setSock
};
