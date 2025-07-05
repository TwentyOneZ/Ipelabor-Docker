const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const ini = require('ini');
const { createObjectCsvWriter } = require('csv-writer');

async function exportarAtendimentos() {
  logger.info('🔍 Lendo config.ini...');
  const configPath = path.join(__dirname, 'config.ini');

  if (!fs.existsSync(configPath)) {
    logger.error('❌ Arquivo config.ini não encontrado!');
    return;
  }

  const config = ini.parse(fs.readFileSync(configPath, 'utf-8'));
  const dbConfig = config.mysql;

  if (!dbConfig) {
    logger.error('❌ Seção [mysql] não encontrada no config.ini');
    return;
  }

  logger.info(`🔌 Conectando ao banco ${dbConfig.database} em ${dbConfig.host}...`);
  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: parseInt(dbConfig.port, 10),
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database
  });

  logger.info('✅ Conectado!');

  const [rows] = await connection.execute(`SELECT * FROM atendimentos`);
  logger.info(`📊 Registros encontrados: ${rows.length}`);

  const agora = new Date();
  const timestamp = agora.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const fileName = `relatorio_${timestamp}.csv`;
  const outputPath = path.join(__dirname, fileName);

  fs.writeFileSync(outputPath, '\uFEFF', 'utf8');

  const registrosFormatados = rows.map(row => {
    const [nomeBruto, empresaBruta] = row.paciente.includes("-")
      ? row.paciente.split("-")
      : [row.paciente, ""];

    const nome = nomeBruto.trim().replace(/["*]/g, '');
    const empresa = empresaBruta.trim().replace(/["*]/g, '');

    const dataObj = new Date(row.data);
    const dataFormatada = `${String(dataObj.getDate()).padStart(2, '0')}/${String(dataObj.getMonth() + 1).padStart(2, '0')}/${dataObj.getFullYear()}`;

    return {
      msgId: row.msgId,
      paciente: nome,
      empresa: empresa || row.empresa?.trim().replace(/["*]/g, '') || '',
      sala: row.sala,
      branch: row.branch || '',
      data: dataFormatada,
      dataComparacao: row.data,
      hora_inicio: row.hora_inicio,
      hora_fim: row.hora_fim,
      duracao: row.duracao
    };
  });

  registrosFormatados.sort((a, b) => {
    const dataA = new Date(`${a.dataComparacao}T${a.hora_inicio || '00:00:00'}`);
    const dataB = new Date(`${b.dataComparacao}T${b.hora_inicio || '00:00:00'}`);
    if (dataA < dataB) return -1;
    if (dataA > dataB) return 1;
    return (a.hora_fim || '').localeCompare(b.hora_fim || '');
  });

  registrosFormatados.forEach(reg => delete reg.dataComparacao);

  const csvWriter = createObjectCsvWriter({
    path: outputPath,
    append: true,
    header: [
      { id: 'msgId', title: 'msgId' },
      { id: 'paciente', title: 'Paciente' },
      { id: 'empresa', title: 'Empresa' },
      { id: 'sala', title: 'Sala' },
      { id: 'branch', title: 'Branch' },
      { id: 'data', title: 'Data' },
      { id: 'hora_inicio', title: 'Hora Início' },
      { id: 'hora_fim', title: 'Hora Fim' },
      { id: 'duracao', title: 'Duração' }
    ]
  });

  await csvWriter.writeRecords(registrosFormatados);
  logger.info(`📄 CSV gerado: ${fileName}`);

  await connection.end();
  logger.info('🔚 Conexão encerrada.');
}

exportarAtendimentos();