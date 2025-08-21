// handlers.js

const { logMessage } = require('./logUtils');
const { getTopicsByBranch, getBranchByChatId, normalizeText } = require('./utils');
const { getPool } = require('./database');
const { getMQTT } = require('./mqttClient');
const logger = require('./logger');
const config = require('./config');

const messageCache = new Map();
const settings = config.settings || {};
const finalizationEmojis = (settings.finalizationEmojis || '')
  .split(',').map(e => e.trim());

// Map<chatId, { msgId: string, text: string }>
const currentAttendance = new Map();

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
async function insertMessage(pool, msgId, chatId, branch, text, fromMe, participant) {
  await pool.query(
    `INSERT IGNORE INTO messages 
       (msgId, chatId, branch, text, fromMe, participant)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [ msgId, chatId, branch, text, fromMe ? 1 : 0, participant ]
  );
}

/**
 * Recupera um texto já armazenado no cache ou no banco.
 */
async function getMessageById(pool, msgId) {
  const [rows] = await pool.query(
    `SELECT chatId, text, fromMe, participant FROM messages WHERE msgId = ?`,
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
  
  // aplica o filtro de casos mal-formatados
  const cleaned = normalizeText(text);
  const parts = cleaned.split(/\s*-\s*/);
  const paciente    = parts[0].trim();
  const empresa = parts.length > 1
    ? parts.slice(1).join(' - ').trim()
    : '';
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
    // limpa apenas reações antigas DESSA MESMA mensagem (mesmo texto)
    const [oldMsgs] = await pool.query(`
      SELECT msgId, fromMe, participant
        FROM messages
      WHERE chatId = ?
        AND text       = ?
        AND \`timestamp\` >= CURDATE()
        AND \`timestamp\` < CURDATE() + INTERVAL 1 DAY
      ORDER BY \`timestamp\` DESC
      LIMIT 10
    `, [ chatId, text ]);

    for (const { msgId, fromMe, participant } of oldMsgs) {
      for (let tentativa = 1; tentativa <= 10; tentativa++) {
        try {
          await sock.sendMessage(chatId, {
            react: { text:'', key:{ id:msgId, remoteJid:chatId, fromMe , participant} }
          });
          await new Promise(res => setTimeout(res, 50));
          break;  // emoji aplicado com sucesso, sai do loop de retry
        } catch (err) {
          logger.error(`❌ falha ao limpar reação em ${config.rooms?.[chatId] || ''} (tentativa ${tentativa}):`, err.message);
          // se não for a última tentativa, aguarda um pouco antes de tentar de novo
          if (tentativa < 10) {
            await new Promise(res => setTimeout(res, tentativa * 50));
          }
        }
      }
    }

    // aplica novo emoji, com até 3 tentativas em cada msgId
    const [matching] = await pool.query(`
      SELECT msgId, fromMe, participant
        FROM messages
      WHERE chatId = ? AND text = ?
        AND \`timestamp\` >= CURDATE()
        AND \`timestamp\` < CURDATE() + INTERVAL 1 DAY
      ORDER BY \`timestamp\` DESC
      LIMIT 10
    `, [ chatId, text ]);

    for (const { msgId, fromMe, participant } of matching) {
      for (let tentativa = 1; tentativa <= 10; tentativa++) {
        try {
          await sock.sendMessage(chatId, {
            react: {
              text: salaEmoji,
              key: { id: msgId, remoteJid: chatId, fromMe, participant }
            }
          });
          logger.info(`✔️ Marcado ${salaEmoji} em ${config.rooms?.[chatId] || ''} para “${text}”`);
          await new Promise(res => setTimeout(res, 50));
          break;  // emoji aplicado com sucesso, sai do loop de retry
        } catch (err) {
          logger.error(`❌ falha ao marcar em ${config.rooms?.[chatId] || ''} (tentativa ${tentativa}):`, err.message);
          // se não for a última tentativa, aguarda um pouco antes de tentar de novo
          if (tentativa < 10) {
            await new Promise(res => setTimeout(res, tentativa * 50));
          }
        }
      }
    }
  }
}

/**
 * Remove a reação (emoji da sala de origem) de TODAS as salas,
 * inclusive a própria.
 */
async function removeMarks(text, origemChatId, sock) {
  const branch = getBranchByChatId(origemChatId);
  if (!branch) return;
  const pool = getPool();
  const chats = config.branches[branch].split(',').map(e => e.trim());
  const salaEmoji = (config.emojis || {})[origemChatId] || '✅';

  for (const chatId of chats) {
    const [rows] = await pool.query(`
      SELECT msgId, fromMe, participant
        FROM messages
       WHERE chatId = ? AND text = ?
         AND \`timestamp\` >= CURDATE()
         AND \`timestamp\` < CURDATE() + INTERVAL 1 DAY
       ORDER BY \`timestamp\` DESC
       LIMIT 10
    `, [ chatId, text ]);

    for (const { msgId, fromMe, participant } of rows) {
      try {
        await sock.sendMessage(chatId, {
          react: {
            text: '',
            key: { id: msgId, remoteJid: chatId, fromMe, participant }
          }
        });
        logger.info(`🗑️ Reação ${salaEmoji} removida em ${config.rooms?.[chatId] || ''} para "${text}"`);
      } catch (e) {
        logger.error(`❌ falha ao remover em ${config.rooms?.[chatId] || ''}:`, e.message);
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
 * Marca os últimos 10 atendimentos de um paciente/empresa como "ASO assinado".
 */
async function signASO(pool, originalText) {
  // Extrai nome e empresa da mensagem original
  const cleaned = normalizeText(originalText);
  const parts = cleaned.split(/\s*-\s*/);
  const paciente = parts[0].trim().replace(/["*]/g, '');
  const empresa = parts.length > 1
    ? parts.slice(1).join(' - ').trim().replace(/["*]/g, '')
    : '';

  // Data e hora atuais para o registro
  const now = new Date();
  const YYYY = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const DD = String(now.getDate()).padStart(2, '0');
  const HH = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ASO_assinado = `${YYYY}-${MM}-${DD} ${HH}:${mm}:${ss}`;

  logger.debug(`🛠️ Marcando ASO para paciente: ${paciente}, empresa: ${empresa}`);

  // Busca os últimos 10 atendimentos para este paciente/empresa que ainda não foram assinados
  const [rows] = await pool.query(`
    SELECT msgId FROM atendimentos
    WHERE paciente = ?
      AND empresa = ?
      AND ASO_assinado IS NULL
    ORDER BY hora_registro DESC
    LIMIT 10
  `, [paciente, empresa]);

  if (rows.length === 0) {
    logger.debug('⏭️ Nenhum registro encontrado para ser assinado.');
    return;
  }

  // Atualiza os registros encontrados com a data e hora atuais
  const msgIds = rows.map(row => row.msgId);
  await pool.query(
    `UPDATE atendimentos SET ASO_assinado = ? WHERE msgId IN (?)`,
    [ASO_assinado, msgIds]
  );
  logger.info(`✍️ ASO assinado para ${rows.length} registros de "${paciente}"`);
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
    logger.debug(`🔍 Debug: Mensagem do chatId: ${chatId}, detectado branch: ${branch}`);
    const topics = branch ? getTopicsByBranch(branch) : null;
    const text   = msg.message?.conversation
                || msg.message?.extendedTextMessage?.text
                || msg.message?.imageMessage?.caption
                || '';

    if (!branch) {
      logger.debug(`⏭️ Ignorando mensagem de chat não mapeado: ${chatId}`);
      continue;
    }

    // --- LÓGICA ESPECÍFICA PARA GRUPOS DE ASSINATURA DE ASO ---
    if (branch === 'grupo_aso') {
      if (msg.message?.reactionMessage) {
        const reaction      = msg.message.reactionMessage;
        const emoji         = reaction.text;
        const reactionMsgId = reaction.key.id;
        const reactedChatId = reaction.key.remoteJid;
        const branchReact   = getBranchByChatId(reactedChatId);
        const participant   = msg.key.participant || msg.key.remoteJid;
  
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
  
        // 🏁 = Registra o ASO
        if (emoji === '😂' && settings.registerDatabase) {
          await signASO(pool, textoOriginal);
        }
  
      }
      // Ignora o resto do processamento para esta branch, pois nada deve ser enviado ao MQTT
      continue;
    }

    // --- LÓGICA PADRÃO PARA OS DEMAIS GRUPOS ---
    // --- 1) Mensagem de texto recebida ---
    if (text) {
      // Só processa se contiver hífen
      if (!text.includes('-')) {
        logger.debug(`❌ Ignorando texto sem hífen: "${text}"`);
        continue;
      } else {
        messageCache.set(msgId, { chatId, text, fromMe: msg.key.fromMe, participant: msg.key.participant || msg.key.remoteJid });
        await insertMessage(pool, msgId, chatId, branch, text, msg.key.fromMe, msg.key.participant || msg.key.remoteJid);

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
      const participant   = msg.key.participant || msg.key.remoteJid;

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

      // ❤️ = inicia atendimento na sala X
      if (emoji === '❤️') {
        const sala = reactedChatId;

        // ➊ Se já houver atendimento ativo, remova marcação e finalize-o
        if (currentAttendance.has(sala)) {
          const { msgId: prevMsgId, text: prevText } = currentAttendance.get(sala);

          // ➊.1 Remove o emoji antigo (daquela sala) de TODAS as salas
          if (settings.markEmojis) {
            await removeMarks(prevText, sala, sock);
          }

          // ➊.2 Finaliza no banco
          if (settings.registerDatabase) {
            const now = new Date();
            const horaAgora = now.toTimeString().slice(0,8);
            await finalizeAttendance(pool, prevMsgId, horaAgora, now);
            logger.info(`🛑 Atendimento anterior em ${config.rooms?.[sala]} finalizado automaticamente.`);
          }
        }

        // ➋ Armazena o novo atendimento (msgId + texto) no Map
        currentAttendance.set(sala, { msgId: reactionMsgId, text: textoOriginal });

        // ➌ Marca com emojiX em todas as salas para a nova mensagem
        if (settings.markEmojis) {
          await markUniqueInRoom(textoOriginal, sala, sock);
        }

        // ➍ Registra início no banco
        if (settings.registerDatabase) {
          const reactedBy = msg.pushName || 'Usuário desconhecido';
          await startAttendance(pool, reactionMsgId, reactedBy);
        }
      }


      // 🏁 = finaliza atendimento na sala X
      else if (finalizationEmojis.includes(emoji)) {
        const sala = reactedChatId;
        const record = currentAttendance.get(sala);
        if (record) {
          const { msgId: msgIdAtual, text: recText } = record;

          // ➊ Finaliza no banco
          if (settings.registerDatabase) {
            const now = new Date();
            const horaAgora = now.toTimeString().slice(0,8);
            await finalizeAttendance(pool, msgIdAtual, horaAgora, now);
          }
          
          // ➋ Se for o emoji '😂', também marca o ASO assinado
          if (emoji === '😂' && settings.registerDatabase) {
            await signASO(pool, textoOriginal);
          }

          // ➋ Remove o emoji daquela sala de TODAS as salas para recText
          if (settings.markEmojis) {
            await removeMarks(recText, sala, sock);
          }

          // ➌ Limpa o rastreador
          currentAttendance.delete(sala);
        }
      }

      if (emoji === '😂' && settings.registerDatabase) {
        await signASO(pool, textoOriginal);
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
