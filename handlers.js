// handlers.js

const { logMessage } = require('./logUtils');
const { getTopicsByBranch, getBranchByChatId } = require('./utils');
const { getPool } = require('./database');
const { getMQTT } = require('./mqttClient');
const logger = require('./logger');
const config = require('./config');

const messageCache = new Map();
const settings = config.settings || {};
const finalizationEmojis = (settings.finalizationEmojis || '')
  .split(',').map(e => e.trim());


  // Main handler function
async function handleIncomingMessages(upsert, sock) {
  logger.debug('🛠️ debug: handleIncomingMessages called, sock defined?', !!sock);
  if (!sock) {
    logger.error('❌ debug: sock é undefined!');
    return;
  }
  if (upsert.type !== 'notify') return;

  const mqttClient = getMQTT();
  const pool = getPool();
  await ensureTables(pool);

  for (const msg of upsert.messages) {
    const msgId = msg.key.id;
    const chatId = msg.key.remoteJid;
    const branch = getBranchByChatId(chatId);
    const topics = branch ? getTopicsByBranch(branch) : null;

    const text = msg.message?.conversation ||
                 msg.message?.extendedTextMessage?.text ||
                 msg.message?.imageMessage?.caption || '';

    if (text && !text.includes('-')) {
      logger.debug(`❌ Ignorando texto sem hífen: "${text}"`);
      continue;
    }
    
    // 1) Texto recebido
    if (text) {
      messageCache.set(msgId, { chatId, text, fromMe: msg.key.fromMe });
      await insertMessage(pool, msgId, chatId, branch, text, msg.key.fromMe);

      // Insere entrada em atendimentos
      const now = new Date();
      const dataHoje   = now.toISOString().slice(0,10);
      const horaRegistro = now.toTimeString().slice(0,8);
      const [paciente, empresa] = text.split(/\s*-\s*/).map(s => s.trim());
      await pool.query(
        `INSERT INTO atendimentos
           (msgId, paciente, empresa, sala, branch, data, hora_registro)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [ msgId, paciente, empresa, chatId, branch, dataHoje, horaRegistro ]
      );
      (err) => {
        if (err) {
          logger.error('❌ Falha ao salvar no banco de dados:', err.message);
        } else {
          logger.info(`📤 Mensagem salva no banco de dados.`);
        }
      }

      logMessage(chatId, text);

      if (topics?.topicMessages) {
        mqttClient.publish(
          topics.topicMessages,
          JSON.stringify({ text, chatId, branch }),
          (err) => {
            if (err) {
              logger.error('❌ Falha ao publicar texto no MQTT:', err.message);
            } else {
              logger.info(`📤 Mensagem publicada em ${topics.topicMessages}`, text);
            }
          }
        );
      } else {
        logger.debug('⚠️ tópicoMessages indefinido para a branch:', branch);
      }
    }

    // 2) Reação recebida
    if (msg.message?.reactionMessage) {
      const reaction = msg.message.reactionMessage;
      const emoji = reaction.text;
      const reactionMsgId = reaction.key.id;
      const reactedChatId = reaction.key.remoteJid;

      const branchReact = getBranchByChatId(reactedChatId);
      if (!branchReact) continue;

      let original = messageCache.get(reactionMsgId);
      if (!original) {
        original = await getMessageById(pool, reactionMsgId);
        if (original) {
          messageCache.set(reactionMsgId, original);
        }
      }

      const textoOriginal = original?.text || '';
      if (!textoOriginal.includes('-')) {
        logger.debug(`❌ Ignorando reação em mensagem sem hífen: "${textoOriginal}"`);
        continue;
      }
      logger.debug('🛠️ debug: textoOriginal:', textoOriginal);

      if (emoji === '❤️' && original) {
        const now = new Date();
        const ano   = now.getFullYear();
        const mes   = String(now.getMonth() + 1).padStart(2, '0');
        const dia   = String(now.getDate()).padStart(2, '0');
        const dataLocal = `${ano}-${mes}-${dia}`;  // "2025-07-02"
        const parts = textoOriginal.split(/\s*-\s*/);
        const nome    = parts[0].trim();
        const empresa = parts.length > 1
          ? parts.slice(1).join(' - ').trim()
          : '';
        const sala = config.rooms?.[reactedChatId];
        const reactedBy = msg.pushName || 'Usuário desconhecido';
        // Marca no Whatsapp
        if (config.settings.markEmojis) {
          await marcarUnicoNaSala(textoOriginal, original.chatId, sock); 
        }
        // Atualiza o banco de dados
        if (config.settings.registerDatabase) {
          await finalizePreviousUnfinishedAttendance(pool, reactedChatId, reactionMsgId, new Date().toTimeString().slice(0, 8), new Date());

          // Insere ou atualiza o atendimento, já calculando o tempo de espera
          const now = new Date();
          const horaInicio = now.toTimeString().slice(0,8);
          const caller     = msg.pushName || 'Usuário desconhecido';

          // 1) Busca hora_registro para calcular a espera
          const [rowsPrev] = await pool.query(
            `SELECT data, hora_registro
              FROM atendimentos
              WHERE msgId = ?`,
            [ reactionMsgId ]
          );

          let espera = null;
          if (rowsPrev.length) {
            const dataPrev = rowsPrev[0].data;
            const horaPrev = rowsPrev[0].hora_registro;
            const ymdPrev  = `${dataPrev.getFullYear()}-${String(dataPrev.getMonth()+1).padStart(2,'0')}-${String(dataPrev.getDate()).padStart(2,'0')}`;
            const dtPrev   = new Date(`${ymdPrev}T${horaPrev}`);
            const durMs    = now - dtPrev;
            const min      = Math.floor(durMs/60000);
            const sec      = Math.floor((durMs%60000)/1000);
            espera         = `${min}m ${sec}s`;
          }

          // 2) Atualiza hora_inicio, caller e espera
          await pool.query(
            `UPDATE atendimentos
                SET hora_inicio = ?, caller = ?, espera = ?
              WHERE msgId = ?`,
            [ horaInicio, caller, espera, reactionMsgId ]
          );
          // await insertOrUpdateAttendance(pool, reactionMsgId, nome, empresa, sala, branchReact, dataLocal, new Date().toTimeString().slice(0, 8), reactedBy);
        }
      } else if (finalizationEmojis.includes(emoji) && original) {
        // Remove marca no Whatsapp
        if (config.settings.markEmojis) {
          await removerMarcacoes(textoOriginal, original.chatId, sock);
        }
        // Atualiza o banco de dados
        if (config.settings.registerDatabase) {
          await finalizeAttendance(pool, reactionMsgId, new Date().toTimeString().slice(0, 8), new Date());
        }
      }

      logMessage(chatId, textoOriginal, true, emoji);
      // Publica a reação raw no MQTT
      if (topics) {
        const reactedBy = msg.pushName || 'Usuário desconhecido';
        const payload = Buffer.from(JSON.stringify({
          reaction: emoji,
          originalMessage: textoOriginal,
          reactedBy,
          chatId,
          encoding: 'utf-8'
        }), 'utf-8').toString();

        mqttClient.publish(
          topics.topicReactionsRaw,
          payload,
          {},
          (err) => {
            if (err) {
              logger.error('❌ Falha ao publicar reação no MQTT:', err.message);
            } else {
              logger.info(`📤 Reação publicada em ${topics.topicReactionsRaw}`);
            }
          }
        );
      }
      
      // Publica a chamada no MQTT
      if (topics && emoji === '❤️') {
        const parts     = textoOriginal.split(/\s*-\s*/);
        const nome      = parts[0].trim();
        const sala = config.rooms?.[reactedChatId];
        const roomShort = config.roomsShort?.[reactedChatId];
        const postCall  = config.postCall?.[reactedChatId];
        const msgId     = msg.key.id;

        // Verifica se é um VIP Caller
        const vipCaller  = config.vipCaller.caller;
        const vipBranch = config.vipCaller.branch;
        const reactedBy = msg.pushName || 'Usuário desconhecido';
        const branchReact = getBranchByChatId(reactedChatId);
        const vipRoom = config.vipCaller.rooms;
        const vipRoomShort = config.vipCaller.roomsShort;
        const vipPostCall  = config.vipCaller.postCall;
        if (reactedBy == vipCaller && branchReact == vipBranch) {
          const payload = Buffer.from(JSON.stringify({
            name: nome,
            room: vipRoom,
            roomShort: vipRoomShort,
            postCall: vipPostCall,
            msgId: msgId,
            encoding: 'utf-8'
          }), 'utf-8').toString();

          mqttClient.publish(
            topics.topicCalls,
            payload,
            {},
            (err) => {
              if (err) {
                logger.error('❌ Falha ao publicar reação no MQTT:', err.message);
              } else {
                logger.info(`📤 Chamado VIP publicado em ${topics.topicCalls}`);
              }
            }
          );
        } else {
          const payload = Buffer.from(JSON.stringify({
            name: nome,
            room: sala,
            roomShort: roomShort,
            postCall: postCall,
            msgId: msgId,
            encoding: 'utf-8'
          }), 'utf-8').toString();

          mqttClient.publish(
            topics.topicCalls,
            payload,
            {},
            (err) => {
              if (err) {
                logger.error('❌ Falha ao publicar reação no MQTT:', err.message);
              } else {
                logger.info(`📤 Chamado publicado em ${topics.topicCalls}`);
              }
            }
          );
        }
      }
    }
  }
}

async function marcarUnicoNaSala(texto, origemChatId, sock) {
  const branch = getBranchByChatId(origemChatId);
  if (!branch) return;

  const chats = config.branches[branch].split(',').map(e => e.trim());
  const pool = getPool();
  await ensureTables(pool);
  const emojiMap = config.emojis || {};
  const salaEmoji = emojiMap[origemChatId] || '✅';

  for (const chatId of chats) {
    const [all] = await pool.query(`
      SELECT
        msgId,
        fromMe
      FROM messages
      WHERE chatId = ?
        AND \`timestamp\` >= CURDATE()
        AND \`timestamp\` <  CURDATE() + INTERVAL 1 DAY
      ORDER BY \`timestamp\` DESC
      LIMIT 10
    `, [chatId]);    
    for (const { msgId, fromMe } of all) {
      try {
        await sock.sendMessage(chatId, {
          react: { text: '', key: { id: msgId, remoteJid: chatId, fromMe } }
        });
      } catch (e) {
        logger.error(`❌ falha ao limpar reação em ${chatId}: ${msgId}`, e.message);
      }
    }

    const [rows] = await pool.query(`
      SELECT
        msgId,
        fromMe
      FROM messages
      WHERE chatId = ?
        AND text = ?
        AND \`timestamp\` >= CURDATE()
        AND \`timestamp\` <  CURDATE() + INTERVAL 1 DAY
      ORDER BY \`timestamp\` DESC
      LIMIT 10
    `, [chatId, texto]);    
    for (const { msgId, fromMe } of rows) {
      try {
        await sock.sendMessage(chatId, {
          react: { text: salaEmoji, key: { id: msgId, remoteJid: chatId, fromMe } }
        });
        logger.info(`✔️ Marcado ${salaEmoji} em ${chatId} para “${texto}”`);
      } catch (e) {
        logger.error(`❌ falha ao marcar em ${chatId}:`, e.message);
      }
    }
  }
}

async function removerMarcacoes(texto, origemChatId, sock) {
  const branch = getBranchByChatId(origemChatId);
  if (!branch) return;

  const chats = config.branches[branch].split(',').map(e => e.trim());
  const pool = getPool();
  await ensureTables(pool);

  for (const chatId of chats) {
    const [rows] = await pool.query(`
      SELECT
        msgId,
        fromMe
      FROM messages
      WHERE chatId = ?
        AND text = ?
        AND \`timestamp\` >= CURDATE()
        AND \`timestamp\` <  CURDATE() + INTERVAL 1 DAY
      ORDER BY \`timestamp\` DESC
      LIMIT 10
    `, [chatId, texto]);
    
    for (const { msgId, fromMe } of rows) {
      try {
        await sock.sendMessage(chatId, {
          react: { text: '', key: { id: msgId, remoteJid: chatId, fromMe } }
        });
        logger.info(`🗑️ Reação removida em ${chatId} para "${texto}"`);
      } catch (e) {
        logger.error(`❌ falha ao remover em ${chatId}:`, e);
      }
    }
  }
}

// Database utility functions
async function insertMessage(pool, msgId, chatId, branch, text, fromMe) {
  await pool.query(
    `INSERT IGNORE INTO messages 
       (msgId, chatId, branch, text, fromMe)
     VALUES (?, ?, ?, ?, ?)`,
    [msgId, chatId, branch, text, fromMe ? 1 : 0]
  );
}

async function getMessageById(pool, msgId) {
  const [rows] = await pool.query(
    `SELECT chatId, text, fromMe FROM messages WHERE msgId = ?`,
    [msgId]
  );
  return rows.length ? rows[0] : null;
}

async function finalizePreviousUnfinishedAttendance(pool, sala, reactionMsgId, horaAgora, now) {
  const [prev] = await pool.query(
    `SELECT msgId, data, hora_inicio
       FROM atendimentos
      WHERE sala = ? AND hora_fim IS NULL AND msgId != ?
      ORDER BY hora_inicio DESC LIMIT 1`,
    [sala, reactionMsgId]
  );

  if (prev.length > 0) {
    const msgIdAnterior = prev[0].msgId;
    const dataPrev = prev[0].data;
    const horaPrev = prev[0].hora_inicio;
    const ymdPrev = `${dataPrev.getFullYear()}-${String(dataPrev.getMonth() + 1).padStart(2, '0')}-${String(dataPrev.getDate()).padStart(2, '0')}`;
    const dtPrev = new Date(`${ymdPrev}T${horaPrev}`);
    const durMs = now - dtPrev;
    const min = Math.floor(durMs / 60000);
    const sec = Math.floor((durMs % 60000) / 1000);
    const duracao = `${min}m ${sec}s`;

    await pool.query(
      `UPDATE atendimentos SET hora_fim = ?, duracao = ? WHERE msgId = ?`,
      [horaAgora, duracao, msgIdAnterior]
    );
    logger.debug('🛠️ debug: finalizando e salvando atendimento anterior no banco de dados.');
  }
}

async function insertOrUpdateAttendance(pool, reactionMsgId, nomePaciente, empresaPaciente, sala, branch, dataHoje, horaAgora, reactedBy) {
  const [exist] = await pool.query(
    `SELECT 1 FROM atendimentos WHERE msgId = ?`,
    [reactionMsgId]
  );

  if (exist.length) {
    await pool.query(
      `UPDATE atendimentos
          SET hora_inicio = ?, hora_fim = NULL, duracao = NULL
        WHERE msgId = ?`,
      [horaAgora, reactionMsgId]
    );
    logger.debug('🛠️ debug: atualizando atendimento existente no banco de dados.');
  } else {
    await pool.query(
      `INSERT INTO atendimentos
        (msgId, paciente, empresa, sala, branch, data, hora_inicio, caller)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [reactionMsgId, nomePaciente.trim(), empresaPaciente.trim(), sala, branch, dataHoje, horaAgora, reactedBy]
    );
    logger.debug('🛠️ debug: inserindo novo atendimento no banco de dados.');    
  }
}

async function finalizeAttendance(pool, reactionMsgId, horaAgora, now) {
  const [rows] = await pool.query(
    `SELECT data, hora_inicio
       FROM atendimentos
      WHERE msgId = ?`,
    [reactionMsgId]
  );

  if (rows.length) {
    const dataInicioObj = rows[0].data;
    const horaInicioStr = rows[0].hora_inicio;
    const ymd = `${dataInicioObj.getFullYear()}-${String(dataInicioObj.getMonth() + 1).padStart(2, '0')}-${String(dataInicioObj.getDate()).padStart(2, '0')}`;
    const dtInicio = new Date(`${ymd}T${horaInicioStr}`);
    const durMs = now - dtInicio;
    const min = Math.floor(durMs / 60000);
    const sec = Math.floor((durMs % 60000) / 1000);
    const duracao = `${min}m ${sec}s`;

    await pool.query(
      `UPDATE atendimentos SET hora_fim = ?, duracao = ? WHERE msgId = ?`,
      [horaAgora, duracao, reactionMsgId]
    );
    logger.debug('🛠️ debug: inserindo atendimento finalizado no banco de dados.');
  }
}

async function ensureTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      msgId VARCHAR(255) PRIMARY KEY,
      chatId VARCHAR(255),
      branch VARCHAR(255),
      text TEXT,
      fromMe BOOLEAN,
      participant VARCHAR(255),
      \`timestamp\` DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_messages_chat_ts (chatId, \`timestamp\`)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS atendimentos (
      msgId VARCHAR(255) PRIMARY KEY,
      paciente VARCHAR(255),
      empresa VARCHAR(255),
      sala VARCHAR(255),
      branch VARCHAR(255),
      \`data\` DATE,
      hora_register TIME,
      hora_inicio TIME,
      hora_fim TIME,
      espera VARCHAR(50),
      duracao VARCHAR(50),
      caller VARCHAR(255)
    )
  `);
}


module.exports = { handleIncomingMessages };
