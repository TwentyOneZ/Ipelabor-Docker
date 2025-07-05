// index.js

// força saída em UTF-8
process.stdout.setDefaultEncoding('utf8');

const { connectMySQL } = require('./database');
const { connectMQTT } = require('./mqttClient');
const { connectWhatsApp, setSock } = require('./whatsappClient');
const logger = require('./logger');

(async () => {
  try {
    // 1) Conecta ao MySQL (pool)
    await connectMySQL();
    logger.info('🗄️ MySQL pronto!');

    // 2) Conecta ao MQTT
    await connectMQTT();
    logger.info('📡 MQTT pronto!');

    // 3) Conecta ao WhatsApp e registra o socket global
    const sock = await connectWhatsApp();
    setSock(sock);
    logger.info('📱 WhatsApp pronto!');
    
  } catch (err) {
    logger.error('❌ Erro na inicialização:', err);
    process.exit(1);
  }
})();
