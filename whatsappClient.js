// whatsappClient.js
const makeWASocket = require('baileys').default
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require('baileys')
const { Boom } = require('@hapi/boom')
const qrcode = require('qrcode-terminal')
const appLogger = require('./logger')              // seu logger de app
const P = require('pino')
const NodeCache = require('node-cache')
const { handleIncomingMessages } = require('./handlers')

let sock = null

// logger específico para o Baileys (pino)
const baileysLogger = P({ level: 'info' }) // mantenha "info" enquanto debuga chaves
const msgRetryCounterCache = new NodeCache()

/**
 * Inicia a conexão com o WhatsApp e armazena a instância em `sock`
 */
async function connectWhatsApp() {
  // >>> Garanta que este path está montado como volume no Docker <<<
  const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth_info')
  const { version, isLatest } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: {
      creds: state.creds,
      // use o logger do pino que o Baileys entende aqui
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    generateHighQualityLinkPreview: true,
    // ajuda a baixar histórico inicial e receber sender keys de grupos
    syncFullHistory: true,
    // controla retries automáticos
    msgRetryCounterCache,
    // retorna mensagem em caso de retry (pode ser simplão no início)
    getMessage: async (key) => {
      // se você armazenar mensagens no DB, recupere aqui. Por ora, retorna undefined.
      return undefined
    },
    // opcional, mas ajuda a receber eventos/chaves enquanto conecta
    markOnlineOnConnect: true,
  })

  appLogger.info(`✅ WhatsApp iniciado (v${version.join('.')}, isLatest=${isLatest})`)

  sock.ev.process(async (events) => {
    // QR / conexão
    if (events['connection.update']) {
      const { connection, lastDisconnect, qr } = events['connection.update']
      if (qr) {
        qrcode.generate(qr, { small: true })
        appLogger.info('📲 Escaneie o QR Code acima para conectar.')
      }
      if (connection === 'open') {
        appLogger.info('✅ WhatsApp conectado!')
      }
      if (connection === 'close') {
        const err = lastDisconnect?.error
        const statusCode = err instanceof Boom ? err.output.statusCode : undefined
        appLogger.warn('❌ WhatsApp desconectado:', err?.message)

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut
        if (shouldReconnect) {
          appLogger.info('🔄 Reconectando em 10s...')
          setTimeout(connectWhatsApp, 10_000)
        } else {
          appLogger.info('⚠️ Sessão expirada. Escaneie o QR Code. Reconectando em 10s...')
          setTimeout(connectWhatsApp, 10_000)
        }
      }
    }

    // salva credenciais/chaves sempre que atualizarem
    if (events['creds.update']) {
      await saveCreds()
    }

    // mensagens novas
    if (events['messages.upsert']) {
      const upsert = events['messages.upsert']

      // ⚠️ IMPORTANTE: NÃO descarte mensagens de distribuição de chaves
      // Se quiser, logue quando vier uma senderKeyDistributionMessage:
      try {
        for (const m of upsert.messages || []) {
          const hasSenderKey = !!m.message?.senderKeyDistributionMessage
          if (hasSenderKey) {
            baileysLogger.info({ chat: m.key.remoteJid }, '📦 senderKeyDistributionMessage recebida')
          }
        }
      } catch (e) {
        // ignore
      }

      // passe a instância `sock` para seu handler
      await handleIncomingMessages(upsert, sock)
    }
  })

  return sock
}

function getSock() {
  if (!sock) throw new Error('⚠️ WhatsApp não conectado. Chame connectWhatsApp() primeiro.')
  return sock
}

function setSock(instance) {
  sock = instance
}

module.exports = {
  connectWhatsApp,
  getSock,
  setSock,
}
