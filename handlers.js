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

/**
 * Garante que as tabelas existam antes de qualquer operação.
 */
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
      hora_registro TIME,
      hora_inicio TIME,
      hora_fim   TIME,
      espera     VARCHAR(50),
      duracao    VARCHAR(50),
      caller     VARCHAR(255),
      INDEX idx_atend_sala_fim_inicio (sala, hora_fim, hora_inicio DESC)
    )
  `);
}

/**
 * Insere no log de mensagens brutas.
 */
async function insertMessage(pool, msgId, chatId, branch, text, fromMe) {
  await pool.query(
    `INSERT IGNORE INTO messages 
       (msgId, chatId, branch, text, fromMe)
     VALUES (?, ?, ?, ?, ?)`,
    [ msgId, chatId, branch, text, fromMe ? 1 : 0 ]
  );
}

/**
 * Recupera um texto já armazenado no cache ou no banco.
 */
async function getMessageById(pool, msgId) {
  const [rows] = await pool.query(
    `SELECT chatId, text, fromMe FROM messages WHERE msgId = ?`,
    [ msgId ]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Insere um novo atendimento no momento em que a mensagem chega.
 */
async function registerAttendanceOnReceive(pool, msgId, chatId, branch, text) {
  const now = new Date();
  const YYYY = now.getFullYear();
  const MM   = String(now.getMonth() + 1).padStart(2, '0');
  const DD   = String(now.getDate()).padStart(2, '0');
  const date = `${YYYY}-${MM}-${DD}`;
  const time = now.toTimeString().slice(0,8);
  const [paciente, empresa] = text.split(/\s*-\s*/).map(s => s.trim());
  const sala = config.rooms?.[chatId] || '';

  await pool.query(
    `INSERT INTO atendimentos
      (msgId, paciente, empresa, sala, branch, \`data\`, hora_registro)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ msgId, paciente, empresa, sala, branch, date, time ]
  );
  logger.debug('🛠️ Inserindo atendimento no banco de dados.');
}

/**
 * Finaliza qualquer atendimento anterior sem hora_fim.
 */
async function finalizePreviousUnfinishedAttendance(pool, sala, reactionMsgId, horaAgora, now) {
  const [prev] = await pool.query(
    `SELECT msgId, data, hora_inicio
       FROM atendimentos
      WHERE sala = ? AND hora_fim IS NULL AND msgId != ?
      ORDER BY hora_inicio DESC LIMIT 1`,
    [ sala, reactionMsgId ]
  );
  if (!prev.length) return;

  const { msgId: prevId, data, hora_inicio: horaInicio } = prev[0];
  const YYYY = data.getFullYear();
  const MM   = String(data.getMonth() + 1).padStart(2, '0');
  const DD   = String(data.getDate()).padStart(2, '0');
  const dtPrev = new Date(`${YYYY}-${MM}-${DD}T${horaInicio}`);
  const diffMs = now - dtPrev;
  const min = Math.floor(diffMs / 60000);
  const sec = Math.floor((diffMs % 60000) / 1000);
  const duracao = `${min}m ${sec}s`;

  await pool.query(
    `UPDATE atendimentos SET hora_fim = ?, duracao = ? WHERE msgId = ?`,
    [ horaAgora, duracao, prevId ]
  );
  logger.debug('🛠️ Finalizando atendimento anterior no banco de dados.');
}

/**
 * Insere hora_inicio, caller e calcula 'espera' entre registro e início.
 */
async function startAttendance(pool, reactionMsgId, caller) {
  const now = new Date();
  const horaInicio = now.toTimeString().slice(0,8);

  // Busca hora_registro para calcular 'espera'
  const [rows] = await pool.query(
    `SELECT data, hora_registro FROM atendimentos WHERE msgId = ?`,
    [ reactionMsgId ]
  );
  let espera = null;
  if (rows.length) {
    const { data, hora_registro: horaReg } = rows[0];
    const YYYY = data.getFullYear();
    const MM   = String(data.getMonth()+1).padStart(2,'0');
    const DD   = String(data.getDate()).padStart(2,'0');
    const dtReg = new Date(`${YYYY}-${MM}-${DD}T${horaReg}`);
    const diffMs = now - dtReg;
    const min = Math.floor(diffMs/60000);
    const sec = Math.floor((diffMs%60000)/1000);
    espera = `${min}m ${sec}s`;
  }

  await pool.query(
    `UPDATE atendimentos 
       SET hora_inicio = ?, caller = ?, espera = ?
     WHERE msgId = ?`,
    [ horaInicio, caller, espera, reactionMsgId ]
  );
  logger.debug('🛠️ Iniciando atendimento (hora_inicio, caller, espera).');
}

/**
 * Finaliza um atendimento já iniciado.
 */
async function finalizeAttendance(pool, reactionMsgId, horaAgora, now) {
  const [rows] = await pool.query(
    `SELECT data, hora_inicio FROM atendimentos WHERE msgId = ?`,
    [ reactionMsgId ]
  );
  if (!rows.length) return;

  const { data, hora_inicio: horaIni } = rows[0];
  const YYYY = data.getFullYear();
  const MM   = String(data.getMonth()+1).padStart(2,'0');
  const DD   = String(data.getDate()).padStart(2,'0');
  const dtIni = new Date(`${YYYY}-${MM}-${DD}T${horaIni}`);
  const diffMs = now - dtIni;
  const min = Math.floor(diffMs/60000);
  const sec = Math.floor((diffMs%60000)/1000);
  const duracao = `${min}m ${sec}s`;

  await pool.query(
    `UPDATE atendimentos SET hora_fim = ?, duracao = ? WHERE msgId = ?`,
    [ horaAgora, duracao, reactionMsgId ]
  );
  logger.debug('🛠️ Finalizando atendimento (hora_fim, duracao).');
}

/**
 * Limpa todas as marcações (até 10 mais recentes) em cada sala.
 */
async function markUniqueInRoom(text, origemChatId, sock) {
  const branch = getBranchByChatId(origemChatId);
  if (!branch) return;
  const pool = getPool();
  const chats = config.branches[branch].split(',').map(e=>e.trim());
  const salaEmoji = (config.emojis || {})[origemChatId] || '✅';

  for (const chatId of chats) {
    // limpa reações anteriores
    const [oldMsgs] = await pool.query(`
      SELECT msgId, fromMe
        FROM messages
       WHERE chatId = ?
         AND \`timestamp\` >= CURDATE()
         AND \`timestamp\` < CURDATE() + INTERVAL 1 DAY
       ORDER BY \`timestamp\` DESC
       LIMIT 10
    `, [ chatId ]);

    for (const { msgId, fromMe } of oldMsgs) {
      try {
        await sock.sendMessage(chatId, {
          react: { text:'', key:{ id:msgId, remoteJid:chatId, fromMe } }
        });
      } catch (e) {
        logger.error(`❌ falha ao limpar reação em ${chatId} msg ${msgId}:`, e.message);
      }
    }

    // aplica novo emoji
    const [matching] = await pool.query(`
      SELECT msgId, fromMe
        FROM messages
       WHERE chatId = ? AND text = ?
         AND \`timestamp\` >= CURDATE()
         AND \`timestamp\` < CURDATE() + INTERVAL 1 DAY
       ORDER BY \`timestamp\` DESC
       LIMIT 10
    `, [ chatId, text ]);

    for (const { msgId, fromMe } of matching) {
      try {
        await sock.sendMessage(chatId, {
          react:{ text:salaEmoji, key:{ id:msgId, remoteJid:chatId, fromMe } }
        });
        logger.info(`✔️ Marcado ${salaEmoji} em ${chatId} para “${text}”`);
      } catch(e) {
        logger.error(`❌ falha ao marcar em ${chatId}:`, e.message);
      }
    }
  }
}

/**
 * Remove marcações de uma mensagem em todas as salas (até 10 mais recentes).
 */
async function removeMarks(text, origemChatId, sock) {
  const branch = getBranchByChatId(origemChatId);
  if (!branch) return;
  const pool = getPool();
  const chats = config.branches[branch].split(',').map(e=>e.trim());

  for (const chatId of chats) {
    const [rows] = await pool.query(`
      SELECT msgId, fromMe
        FROM messages
       WHERE chatId = ? AND text = ?
         AND \`timestamp\` >= CURDATE()
         AND \`timestamp\` < CURDATE() + INTERVAL 1 DAY
       ORDER BY \`timestamp\` DESC
       LIMIT 10
    `, [ chatId, text ]);

    for (const { msgId, fromMe } of rows) {
      try {
        await sock.sendMessage(chatId, {
          react:{ text:'', key:{ id:msgId, remoteJid:chatId, fromMe } }
        });
        logger.info(`🗑️ Reação removida em ${chatId} para "${text}"`);
      } catch(e) {
        logger.error(`❌ falha ao remover em ${chatId}:`, e.message);
      }
    }
  }
}

/**
 * Publica a reação "raw" no MQTT.
 */
function publishReactionRaw(topics, emoji, originalMessage, chatId, reactedBy) {
  const payload = Buffer.from(JSON.stringify({
    reaction: emoji,
    originalMessage,
    reactedBy,
    chatId,
    encoding: 'utf-8'
  }), 'utf-8').toString();

  getMQTT().publish(topics.topicReactionsRaw, payload, {}, err => {
    if (err) logger.error('❌ Falha ao publicar reação raw no MQTT:', err.message);
    else    logger.info(`📤 Reação raw publicada em ${topics.topicReactionsRaw}`);
  });
}

/**
 * Publica o chamado (VIP ou normal) no MQTT.
 */
function publishCall(topics, name, reactedChatId, msgId, reactedBy) {
  const branchReact = getBranchByChatId(reactedChatId);
  // parâmetros de VIP
  const vipCaller  = config.vipCaller.caller;
  const vipBranch  = config.vipCaller.branch;
  const isVip      = reactedBy === vipCaller && branchReact === vipBranch;

  const room      = isVip
    ? config.vipCaller.rooms
    : config.rooms?.[reactedChatId];
  const roomShort = isVip
    ? config.vipCaller.roomsShort
    : config.roomsShort?.[reactedChatId];
  const postCall  = isVip
    ? config.vipCaller.postCall
    : config.postCall?.[reactedChatId];

  const payload = Buffer.from(JSON.stringify({
    name,
    room,
    roomShort,
    postCall,
    msgId,
    encoding: 'utf-8'
  }), 'utf-8').toString();

  getMQTT().publish(
    topics.topicCalls,
    payload,
    {},
    err => {
      if (err) logger.error('❌ Falha ao publicar chamado no MQTT:', err.message);
      else    logger.info(`📤 Chamado ${isVip ? 'VIP ' : ''}publicado em ${topics.topicCalls}`);
    }
  );
}

/**
 * Processa um batch de mensagens.upsert
 */
async function handleIncomingMessages(upsert, sock) {
  logger.debug('🛠️ handleIncomingMessages chamado, sock definido?', !!sock);
  if (!sock) {
    logger.error('❌ sock é undefined!');
    return;
  }
  if (upsert.type !== 'notify') return;

  const mqttClient = getMQTT();
  const pool       = getPool();
  await ensureTables(pool);

  for (const msg of upsert.messages) {
    const msgId  = msg.key.id;
    const chatId = msg.key.remoteJid;
    const branch = getBranchByChatId(chatId);
    const topics = branch ? getTopicsByBranch(branch) : null;
    const text   = msg.message?.conversation
                || msg.message?.extendedTextMessage?.text
                || msg.message?.imageMessage?.caption
                || '';

    // --- 1) Mensagem de texto recebida ---
    if (text) {
      // Só processa se contiver hífen
      if (!text.includes('-')) {
        logger.debug(`❌ Ignorando texto sem hífen: "${text}"`);
      } else {
        messageCache.set(msgId, { chatId, text, fromMe: msg.key.fromMe });
        await insertMessage(pool, msgId, chatId, branch, text, msg.key.fromMe);

        if (settings.registerDatabase) {
          await registerAttendanceOnReceive(pool, msgId, chatId, branch, text);
        }

        logMessage(chatId, text);

        if (topics?.topicMessages) {
          mqttClient.publish(
            topics.topicMessages,
            JSON.stringify({ text, chatId, branch }),
            err => {
              if (err) logger.error('❌ Falha ao publicar texto no MQTT:', err.message);
              else    logger.info(`📤 Mensagem publicada em ${topics.topicMessages}`, text);
            }
          );
        } else {
          logger.debug('⚠️ tópicoMessages indefinido para a branch:', branch);
        }
      }
    }

    // --- 2) Reação recebida ---
    if (msg.message?.reactionMessage) {
      const reaction      = msg.message.reactionMessage;
      const emoji         = reaction.text;
      const reactionMsgId = reaction.key.id;
      const reactedChatId = reaction.key.remoteJid;
      const branchReact   = getBranchByChatId(reactedChatId);
      if (!branchReact) continue;

      // Recupera texto original
      let original = messageCache.get(reactionMsgId);
      if (!original) {
        original = await getMessageById(pool, reactionMsgId);
        if (original) messageCache.set(reactionMsgId, original);
      }
      const textoOriginal = original?.text || '';

      // Só processa se contiver hífen
      if (!textoOriginal.includes('-')) {
        logger.debug(`❌ Ignorando reação em mensagem sem hífen: "${textoOriginal}"`);
        continue;
      }

      // ❤️ = inicia atendimento
      if (emoji === '❤️') {
        // marca no WhatsApp
        if (settings.markEmojis) {
          await markUniqueInRoom(textoOriginal, original.chatId, sock);
        }

        // atualiza DB
        if (settings.registerDatabase) {
          const now = new Date();
          const horaAgora = now.toTimeString().slice(0,8);

          await finalizePreviousUnfinishedAttendance(
            pool, reactedChatId, reactionMsgId, horaAgora, now
          );

          const reactedBy = msg.pushName || 'Usuário desconhecido';
          await startAttendance(pool, reactionMsgId, reactedBy);
        }
      }
      // 🏁 = finaliza atendimento
      else if (finalizationEmojis.includes(emoji)) {
        if (settings.markEmojis) {
          await removeMarks(textoOriginal, original.chatId, sock);
        }
        if (settings.registerDatabase) {
          const now = new Date();
          const horaAgora = now.toTimeString().slice(0,8);
          await finalizeAttendance(pool, reactionMsgId, horaAgora, now);
        }
      }

      // log e publishes
      logMessage(chatId, textoOriginal, true, emoji);
      if (topics) {
        const reactedBy = msg.pushName || 'Usuário desconhecido';
        publishReactionRaw(topics, emoji, textoOriginal, chatId, reactedBy);

        if (emoji === '❤️') {
          // publica o chamado
          const name = textoOriginal.split(/\s*-\s*/)[0].trim();
          publishCall(topics, name, reactedChatId, reactionMsgId, msg.pushName);
        }
      }
    }
  }
}

module.exports = { handleIncomingMessages };
