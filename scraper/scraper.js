// scraper/scraper.js (CommonJS)

const puppeteer = require("puppeteer");
const logger = require('./logger'); 
const { connectMySQL, getPool } = require('./database'); 
const config = require('./config');

// Usamos o mqttClient e os utils da raiz para publicar no mesmo padrão do handlers.js
const { connectMQTT, getMQTT } = require('../mqttClient');
const { getTopicsByBranch } = require('../utils');



// URL fornecida no seu arquivo
const url = "https://core.sistemaeso.com.br/saladechegada/69e380?w[0]=57f46ad9&w[1]=08ea32b9&w[2]=1503f023&w[3]=24182222&w[4]=33468ea1&w[5]=4519fa97&w[6]=144e2b99";

function normalizeName(name) {
  if (!name) return '';
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
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


// Conjunto em memória para evitar duplicatas durante a vida do processo
const seenCalls = new Set();
/**
 * Publica o chamado raspado no MQTT no mesmo formato do publishCall() em handlers.js.
 */
function publishScrapedCall(scrapedData, msgId) {
  try {
    // Branch usada para buscar os tópicos MQTT. 
    // Você pode configurar em [branch_names] do config.ini: scraperBranch = matriz (por exemplo)
    const branchForMQTT = (config.branch_names && config.branch_names.scraper) || 'scraper';
    const topics = getTopicsByBranch(branchForMQTT);

    if (!topics || !topics.topicCalls) {
      logger.warn('⚠️ Tópico MQTT para chamadas (topicCalls) não configurado para o branch do scraper.');
      return;
    }

    const name = scrapedData.nome;
    const room = scrapedData.sala || '';
    const roomShort = scrapedData.sala || '';
    const postCall = null; // para o painel, se precisar, você pode ajustar depois

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
  const salaNome  = (scrapedData.sala   || '').trim();
  const atendente = (scrapedData.medico || '').trim();

  const branch = (config.branch_names && config.branch_names.scraper) || 'scraper';

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
        { ...scrapedData, nome: paciente, sala: salaNome, medico: atendente },
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
      { ...scrapedData, nome: paciente, sala: salaNome, medico: atendente },
      msgId
    );

    return true;

  } catch (error) {
    logger.error(`❌ Erro ao salvar/atualizar chamado raspado: ${error.message}`);
    return false;
  }
}



async function runScraper() {
  let browser;
  try {
    // Configuração para rodar o Puppeteer dentro do Docker
    browser = await puppeteer.launch({ 
        headless: 'new',
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Necessário no Docker
        ] 
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2" });

    await page.waitForSelector(".card");

    let nomesAtuais = [];
    logger.info('🤖 Scraper iniciado. Checando a cada 10s...');
    
    const pool = getPool(); 

    while (true) {
        // Lógica de raspagem dos dados
        const dados = await page.$$eval(".card", cards =>
          cards
            .map(c => ({
              nome:   c.querySelector(".personMain")?.innerText.trim()   || "",
              medico: c.querySelector(".providerMain")?.innerText.trim() || "",
              sala:   c.querySelector(".hallMain")?.innerText.trim()     || ""
            }))
            .filter(c => c.nome !== "")
        );

        // Detecta novos chamados (baseado no nome normalizado + sala, para evitar repetições mesmo se mudar caixa/acentos)
        const novos = dados.filter(c => {
          return !nomesAtuais.some(a =>
            normalizeName(a.nome) === normalizeName(c.nome) &&
            a.sala === c.sala
          );
        });

        if (novos.length > 0) {
          logger.info(`🔔 ${novos.length} novos chamados detectados.`);

          for (const novo of novos) {
            await saveScrapedCall(pool, novo);
          }
        }
        
        // Atualiza o estado: nomes/salas que estão atualmente na tela
        nomesAtuais = dados;

        await new Promise(r => setTimeout(r, 100)); // checa a cada 100 milisegundos
    }
  } catch (e) {
    logger.error('❌ Erro fatal no scraper', e);
  } finally {
    if (browser) {
        // Não fechar o browser no loop infinito, mas garantir que feche em caso de erro.
        // Já que o loop é infinito, este 'finally' só é executado em erro.
        await browser.close();
    }
  }
}

// ---- bootstrap do scraper ----

(async () => {
  try {
      console.log('>>> [SCRAPER] Script iniciou dentro do container');
      logger.info('⚙️ Iniciando serviço Scraper.'); 
      
      logger.info('⚙️ Tentando conectar ao MySQL...'); 
      await connectMySQL();
      logger.info('✅ Conexão MySQL estabelecida.');

      logger.info('⚙️ Conectando ao MQTT...');
      await connectMQTT();
      logger.info('✅ Conectado ao MQTT. Iniciando raspagem...');

      await runScraper();
  } catch (error) {
      logger.error('❌ Falha na inicialização do scraper', error);
      console.error(error);
      process.exit(1);
  }
})();
