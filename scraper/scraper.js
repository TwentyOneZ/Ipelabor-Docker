// scraper/scraper.js (CommonJS)

const puppeteer = require("puppeteer");
const logger = require('./logger'); 
const { connectMySQL, getPool } = require('./database'); 
const config = require('./config');

// Usamos o mqttClient e os utils da raiz para publicar no mesmo padrão do handlers.js
const { connectMQTT, getMQTT } = require('../mqttClient');
const { getTopicsByBranch } = require('../utils');

const url =
  (config.scraper && config.scraper.url)
    ? config.scraper.url
    : null;

if (!url) {
  logger.error("❌ URL do scraper não definida no config.ini (seção [scraper]).");
  process.exit(1);
}

function normalizeName(name) {
  if (!name) return '';
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isCallAgainSala(sala) {
  const norm = normalizeName(sala);
  return norm === 'CHAMAR NOVAMENTE';
}

function slugify(str) {
  return (str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/[^A-Z0-9_]/g, '')
    .trim();
}

// Gera um msgId único e determinístico para (Nome, Sala, Branch, Data)
function generateMsgId(paciente, salaNome, branch, date) {
  const nameSlug = slugify(paciente);
  const roomSlug = slugify(salaNome);
  const branchSlug = slugify(branch);
  // Ex: SCRAPER_2025-11-15_MATRIZ_GUSTAVO_SOUTO_DE_SA_E_SOUZA_PSICOLOGIA
  return `SCRAPER_${date}_${branchSlug}_${nameSlug}_${roomSlug}`;
}

// Converte texto "Matriz - Audiometria" ou "T63 – Chamar novamente" em:
// { sala: "Audiometria" / "Chamar novamente", branch: "matriz" / "t63" }
function parseSalaAndBranch(rawSala) {
  const fallbackBranch = (config.branch_names && config.branch_names.scraper) || 'scraper';

  if (!rawSala) {
    return { sala: '', branch: fallbackBranch };
  }

  // Divide por "-" OU por "–" (travessão)
  const parts = rawSala.split(/[-–]/).map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) {
    // Não tem branch explícito, devolve sala inteira + branch padrão
    return { sala: rawSala.trim(), branch: fallbackBranch };
  }

  // Novo formato: "Branch - Sala" / "Branch – Sala"
  const branchLabel = parts[0];                          // "Matriz", "T63", etc.
  const salaName    = parts.slice(1).join(' - ').trim(); // "Audiometria", "Chamar novamente", etc.

  const labelNorm = normalizeName(branchLabel);          // "MATRIZ", "T63", ...

  let branch = null;

  // Mapeia o texto para uma chave/valor de [branch_names] no config.ini
  if (config.branch_names) {
    for (const [key, value] of Object.entries(config.branch_names)) {
      const keyNorm = normalizeName(key);
      const valNorm = normalizeName(String(value || ''));
      if (labelNorm === keyNorm || labelNorm === valNorm) {
        branch = value || key; // ex: "matriz" ou "t63"
        break;
      }
    }
  }

  if (!branch) {
    branch = fallbackBranch;
  }

  return { sala: salaName, branch };
}



// Conjunto em memória para evitar duplicatas durante a vida do processo
const seenCalls = new Set();
/**
 * Publica o chamado raspado no MQTT no mesmo formato do publishCall() em handlers.js.
 */
function publishScrapedCall(scrapedData, msgId) {
  try {
    // Branch usada para buscar os tópicos MQTT vem do próprio chamado
    const branchForMQTT =
      scrapedData.branch ||
      (config.branch_names && config.branch_names.scraper) ||
      'scraper';

    const topics = getTopicsByBranch(branchForMQTT);

    if (!topics || !topics.topicCalls) {
      logger.warn('⚠️ Tópico MQTT para chamadas (topicCalls) não configurado para o branch do scraper.');
      return;
    }

    const name = scrapedData.nome;
    const room = scrapedData.sala || '';      // já estará sem o "- Matriz"
    const roomShort = scrapedData.sala || '';
    const postCall = null;

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
        if (err) logger.error('❌ Falha ao publicar chamado raspado no MQTT:', err.message);
        else    logger.info(`📤 Chamado raspado publicado em ${topics.topicCalls} para "${name}" / "${room}"`);
      }
    );
  } catch (err) {
    logger.error('❌ Erro ao tentar publicar chamado raspado no MQTT:', err.message);
  }
}



async function saveScrapedCall(pool, scrapedData) {
  const now = new Date();
  const YYYY = now.getFullYear();
  const MM   = String(now.getMonth() + 1).padStart(2, '0');
  const DD   = String(now.getDate()).padStart(2, '0');
  const date = `${YYYY}-${MM}-${DD}`;
  const time = now.toTimeString().slice(0, 8);

  const paciente  = (scrapedData.nome   || '').trim();
  const salaNome  = (scrapedData.sala   || '').trim();      // já virá sem "Matriz -", apenas "Audiometria" ou "Chamar novamente"
  const atendente = (scrapedData.medico || '').trim();
  const branch    = (scrapedData.branch || '').trim() ||
                    (config.branch_names && config.branch_names.scraper) ||
                    'scraper';

  // 🔁 CASO ESPECIAL: sala "Chamar novamente"
  if (isCallAgainSala(salaNome)) {
    try {
      // Busca o ÚLTIMO atendimento desse branch no dia
      const [rows] = await pool.query(
        `SELECT msgId, paciente, sala, branch, \`data\`, hora_registro, caller
           FROM atendimentos
          WHERE \`data\` = ?
            AND branch = ?
          ORDER BY hora_registro DESC
          LIMIT 1`,
        [date, branch]
      );

      if (rows.length === 0) {
        logger.warn(`⚠️ Sala "Chamar novamente" acionada, mas não há atendimento anterior para o branch "${branch}" na data ${date}. Nada a repetir.`);
        return false;
      }

      const last = rows[0];

      // Atualiza só a hora do último chamado (opcional, mas útil para relatórios)
      await pool.query(
        `UPDATE atendimentos
            SET hora_registro = ?
          WHERE msgId = ?`,
        [time, last.msgId]
      );

      logger.info(
        `🔁 Rechamada via sala "Chamar novamente": repetindo ${last.paciente} em ${last.sala} `
        + `(branch: ${branch}, msgId: ${last.msgId})`
      );

      // Publica NOVAMENTE no MQTT o último chamado real daquela branch
      publishScrapedCall(
        {
          nome:   last.paciente,
          sala:   last.sala,
          branch: branch,
          medico: last.caller || atendente
        },
        last.msgId
      );

      return true;
    } catch (error) {
      logger.error(`❌ Erro ao executar rechamada via "Chamar novamente": ${error.message}`);
      return false;
    }
  }

  // 🔎 Fluxo normal (salas reais, não "Chamar novamente")

  // msgId determinístico para (Nome, Sala, Branch, Data)
  const msgId = generateMsgId(paciente, salaNome, branch, date);

  try {
    // Verifica se já existe atendimento para ESTE Nome + Sala + Branch + Data
    const [rows] = await pool.query(
      `SELECT msgId, paciente, sala, hora_registro, caller
         FROM atendimentos
        WHERE \`data\` = ?
          AND branch = ?
          AND sala = ?
          AND UPPER(paciente) = UPPER(?)
        LIMIT 1`,
      [date, branch, salaNome, paciente]
    );

    if (rows.length > 0) {
      // Já existe esse Nome+Sala+Branch+Data → atualiza com novo horário e caller
      const last = rows[0];

      await pool.query(
        `UPDATE atendimentos
            SET paciente = ?, sala = ?, hora_registro = ?, caller = ?
          WHERE msgId = ?`,
        [
          paciente,
          salaNome,
          time,
          atendente || 'Sistema Externo',
          last.msgId
        ]
      );

      logger.info(
        `♻️ Chamado atualizado para ${paciente} em ${salaNome} `
        + `(msgId: ${last.msgId}, caller: ${atendente || 'Sistema Externo'})`
      );

      // Publica de novo no MQTT usando o MESMO msgId
      publishScrapedCall(
        { ...scrapedData, nome: paciente, sala: salaNome, branch, medico: atendente },
        last.msgId
      );

      return true;
    }

    // Não existe ainda este Nome+Sala+Branch+Data → cria NOVO registro
    await pool.query(
      `INSERT INTO atendimentos
        (msgId, paciente, empresa, sala, branch, \`data\`, hora_registro, caller)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msgId,
        paciente,
        '', // empresa em branco
        salaNome,
        branch,
        date,
        time,
        atendente || 'Sistema Externo'
      ]
    );

    logger.info(
      `💾 Chamado raspado registrado: ${paciente} em ${salaNome} `
      + `(msgId: ${msgId}, Atendente: ${atendente || 'N/D'})`
    );

    // Publica no MQTT com o NOVO msgId
    publishScrapedCall(
      { ...scrapedData, nome: paciente, sala: salaNome, branch, medico: atendente },
      msgId
    );

    return true;

  } catch (error) {
    logger.error(`❌ Erro ao salvar/atualizar chamado raspado: ${error.message}`);
    return false;
  }
}


async function runScraperOnce() {
  let browser;
  try {
    // Configuração para rodar o Puppeteer dentro do Docker
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
      // evita timeout curto de launch
      protocolTimeout: 120000
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(120000);
    page.setDefaultNavigationTimeout(120000);
    await page.goto(url, { waitUntil: "networkidle2" });

    logger.info(`🌐 Página do painel carregada: ${url}`);

    const pool = getPool();
    let nomesAtuais = [];

    logger.info('🤖 Scraper iniciado. Checando a cada 1000ms...');

    while (true) {

      try {
        await page.waitForSelector(".card", { timeout: 10000 });
      } catch (err) {
        // Nenhum card encontrado — seguir rodando SEM recarregar a página
        logger.debug('⏳ Nenhum card encontrado ainda. Mantendo a página aberta e aguardando...');
        await new Promise(r => setTimeout(r, 500)); // espera 500ms e tenta de novo
        continue; // volta ao while sem fazer nada
      }

      const dadosRaw = await page.$$eval(".card", cards =>
        cards
          .map(c => ({
            nome:   c.querySelector(".personMain")?.innerText.trim()   || "",
            medico: c.querySelector(".providerMain")?.innerText.trim() || "",
            sala:   c.querySelector(".hallMain")?.innerText.trim()     || ""
          }))
          .filter(c => c.nome !== "")
      );

      const dados = dadosRaw.map(c => {
        const parsed = parseSalaAndBranch(c.sala);
        return {
          ...c,
          sala: parsed.sala,
          branch: parsed.branch
        };
      });

      // Detecta novos chamados considerando nome normalizado + sala + branch
      const novos = dados.filter(c => {
        return !nomesAtuais.some(a =>
          normalizeName(a.nome) === normalizeName(c.nome) &&
          a.sala === c.sala &&
          a.branch === c.branch
        );
      });

      if (novos.length > 0) {
        logger.info(`🔔 ${novos.length} novos chamados detectados.`);
        for (const novo of novos) {
          await saveScrapedCall(pool, novo);
        }
      }

      nomesAtuais = dados;

      // Intervalo entre checks
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (e) {
    // NÃO derruba o processo aqui — só deixa subir pra quem chamou
    logger.error('❌ Erro dentro do runScraperOnce:', e);
    throw e;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        logger.warn('⚠️ Erro ao fechar browser no finally:', e.message);
      }
    }
  }
}

// ---- bootstrap do scraper ----

(async () => {
  console.log('>>> [SCRAPER] Script iniciou dentro do container');
  try {
    logger.info('⚙️ Tentando conectar ao MySQL...');
    await connectMySQL();
    logger.info('✅ Conexão MySQL estabelecida.');

    logger.info('⚙️ Conectando ao MQTT...');
    await connectMQTT();
    logger.info('✅ Conectado ao broker MQTT.');

    // Loop de retry infinito: se o runScraperOnce der erro (launch, navegação, etc),
    // esperamos alguns segundos e tentamos de novo.
    while (true) {
      try {
        logger.info('🚀 Iniciando ciclo do scraper...');
        await runScraperOnce();
      } catch (err) {
        logger.error('💥 Erro no ciclo do scraper. Vai reiniciar em 10 segundos...', err);
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  } catch (error) {
    logger.error('❌ Falha crítica na inicialização do scraper (MySQL/MQTT).', error);
    console.error(error);
    // Aqui sim faz sentido morrer, porque sem DB/MQTT não há o que fazer
    process.exit(1);
  }
})();

