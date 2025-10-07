// server.js

// 1. Importações
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const path = require("path");
const mysql = require("mysql2");
const fs = require("fs");
const ini = require("ini");
const bcrypt = require('bcryptjs');
const logger = require('./logger');
const crypto = require('crypto');
const { sendPasswordResetEmail } = require('./email'); // <-- ДОБАВЬТЕ ЭТУ СТРОКУ
const XLSX = require('xlsx');

// 2. Inicialização do App
const app = express();
const PORT = 3000;

// Leitura do config.ini
const config = ini.parse(
  fs.readFileSync(path.join(__dirname, "../config.ini"), "utf-8")
);
const db = mysql.createPool({
  host: config.mysql.host,
  port: config.mysql.port,
  user: config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database
}).promise();


// 3. Configuração de Middleware
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(
  session({
    secret: "segredoUltraSeguro",
    resave: false,
    saveUninitialized: true
  })
);

// --- Funções Auxiliares e de Autenticação ---

function auth(req, res, next) {
  if (req.session.loggedIn) {
    // Se o usuário está logado e tentando acessar uma página que não seja de troca de senha
    // enquanto é forçado a trocar, redirecione-o.
    if (req.session.forcarTrocaSenha && req.path !== '/trocar-senha') {
      return res.redirect('/trocar-senha');
    }
    return next();
  }
  res.redirect("/");
}

function exigirTrocaSenha(req, res, next) {
  // Garante que apenas usuários forçados a trocar a senha acessem esta rota
  if (req.session.forcarTrocaSenha) {
    return next();
  }
  res.redirect("/search");
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dt = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dt}`;
}

// 4. Definição das Rotas

// Rota da página de login
app.get("/", (req, res) => {
  const error = req.session.error;
  delete req.session.error;
  res.render("login", { error });
});


app.post("/login", async (req, res) => { 
  const { username, password } = req.body;

  try {
    // Use try/catch para erros e await para o resultado
    const [results] = await db.query( // Mude para await db.query()
      "SELECT id, username, password_hash, nivel_acesso, restricoes, senha_temporaria, empresa FROM usuarios WHERE username = ? LIMIT 1",
      [username]
    );

    if (results.length === 0) {
      req.session.error = "Usuário ou senha inválidos.";
      return res.redirect("/");
    }

    const user = results[0];
    const match = await bcrypt.compare(password, user.password_hash);
    
    if (!match) {
      req.session.error = "Usuário ou senha inválidos.";
      return res.redirect("/");
    }

    // Login OK → configura sessão
    req.session.loggedIn = true;
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.nivelAcesso = user.nivel_acesso;
    req.session.restricoes = user.restricoes ? JSON.parse(user.restricoes) : null;
    req.session.empresa = user.empresa || null;

    if (user.senha_temporaria) {
      req.session.forcarTrocaSenha = true;
      return res.redirect("/trocar-senha");
    }

    return res.redirect("/search");

  } catch (err) {
    logger.error("Erro no processo de login:", err);
    req.session.error = "Erro interno.";
    return res.redirect("/");
  }
});

app.get("/search", auth, (req, res) => {
  const hoje = todayISO();
  res.render("search", {
    results: [],
    filters: {
      name:      "",
      empresa:   "",
      sala:      "",
      branch:    "",
      caller:    "",
      startDate: hoje,
      endDate:   hoje
    },
    sorting: { sortBy: "data", sortDir: "DESC" },
    nivelAcesso: req.session.nivelAcesso
  });
});

app.post("/search", auth, async (req, res) => {
  const {
    name      = '',
    empresa   = '',
    sala      = '',
    branch    = '',
    caller    = '',
    startDate = '',
    endDate   = '',
    asoAssinado = 'Todos' // <-- NOVO FILTRO
  } = req.body;

  try {
    const filtrosParaLog = { name, empresa, sala, branch, caller, startDate, endDate, asoAssinado };
    const usernameLog = req.session.username; // Pega o username da sessão

    const logSql = "INSERT INTO log_buscas (username, filtros) VALUES (?, ?)";
    db.query(logSql, [usernameLog, JSON.stringify(filtrosParaLog)]);
    
  } catch (logError) {
    logger.error("Falha ao registrar log da busca:", logError);
  }
  
  
  const allowedSortColumns = ['msgId', 'paciente', 'empresa', 'sala', 'branch', 'data', 'caller', 'ASO_assinado'];
  const sortBy  = allowedSortColumns.includes(req.body.sortBy) ? req.body.sortBy : 'data';
  const sortDir = req.body.sortDir === 'ASC' ? 'ASC' : 'DESC';

  const clauses = [];
  const params  = [];
  if (name)      { clauses.push("paciente LIKE ?"); params.push(`%${name}%`); }
  if (empresa)   { clauses.push("empresa LIKE ?");  params.push(`%${empresa}%`); }
  if (sala)      { clauses.push("sala LIKE ?");     params.push(`%${sala}%`); }
  if (branch)    { clauses.push("branch LIKE ?");   params.push(`%${branch}%`); }
  if (caller)    { clauses.push("caller LIKE ?");   params.push(`%${caller}%`); }
  if (startDate) { clauses.push("data >= ?");       params.push(startDate);       }
  if (endDate)   { clauses.push("data <= ?");       params.push(endDate);         }
  // <-- LÓGICA DO NOVO FILTRO AQUI
  if (asoAssinado === 'Sim') {
    clauses.push("ASO_assinado IS NOT NULL");
  } else if (asoAssinado === 'Não') {
    clauses.push("ASO_assinado IS NULL");
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const sql = `
    SELECT
      msgId,
      paciente,
      empresa,
      sala,
      branch,
      data,
      hora_registro,
      hora_inicio,
      hora_fim,
      espera,
      duracao,
      caller,
      ASO_assinado
    FROM atendimentos
    ${where}
    ORDER BY \`${sortBy}\` ${sortDir}
  `;

  try {
    const [results] = await db.query(sql, params);
    res.render("search", {
      results,
      filters: { name, empresa, sala, branch, startDate, endDate, caller, asoAssinado }, // <-- PASSA NOVO FILTRO PARA A VIEW
      sorting: { sortBy, sortDir },
      nivelAcesso: req.session.nivelAcesso
    });
  } catch (err) {
    logger.error("Erro na busca do banco de dados:", err);
    return res.status(500).send("Erro no banco de dados.");
  }
});

app.get("/export", auth, async (req, res) => {
  // 1. Pega os mesmos filtros da busca, mas via req.query
  const {
      name = '',
      empresa = '',
      sala = '',
      branch = '',
      caller = '',
      startDate = '',
      endDate = '',
      asoAssinado = 'Todos' // <-- NOVO FILTRO
  } = req.query;

  // 2. Monta a query SQL (lógica idêntica à da busca)
  const clauses = [];
  const params = [];
  if (name) { clauses.push("paciente LIKE ?"); params.push(`%${name}%`); }
  if (empresa) { clauses.push("empresa LIKE ?"); params.push(`%${empresa}%`); }
  if (sala) { clauses.push("sala LIKE ?"); params.push(`%${sala}%`); }
  if (branch) { clauses.push("branch LIKE ?"); params.push(`%${branch}%`); }
  if (caller) { clauses.push("caller LIKE ?"); params.push(`%${caller}%`); }
  if (startDate) { clauses.push("data >= ?"); params.push(startDate); }
  if (endDate) { clauses.push("data <= ?"); params.push(endDate); }
  // <-- LÓGICA DO NOVO FILTRO AQUI
  if (asoAssinado === 'Sim') {
    clauses.push("ASO_assinado IS NOT NULL");
  } else if (asoAssinado === 'Não') {
    clauses.push("ASO_assinado IS NULL");
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `
    SELECT paciente, empresa, sala, branch, data, hora_registro, hora_inicio, hora_fim, espera, duracao, caller, ASO_assinado
    FROM atendimentos
    ${where}
    ORDER BY data DESC, hora_registro DESC
  `;

  try {
      const [results] = await db.query(sql, params);

      // 3. Prepara os dados para o XLSX
      const dataForSheet = results.map(r => {
          // Formata a data para o padrão brasileiro
          const dataFormatada = r.data ? new Date(r.data).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '';
          const asoAssinadoFormatado = r.ASO_assinado ? new Date(r.ASO_assinado).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : ''; // NOVO CAMPO
          return {
              'Paciente': r.paciente,
              'Empresa': r.empresa,
              'Sala': r.sala,
              'Local': r.branch,
              'Data': dataFormatada,
              'Registro': r.hora_registro,
              'Início': r.hora_inicio,
              'Fim': r.hora_fim,
              'Espera': r.espera,
              'Duração': r.duracao,
              'Atendente': r.caller,
              'ASO Assinado': asoAssinadoFormatado // NOVO CAMPO
          };
      });

      // 4. Cria o arquivo XLSX em memória
      const worksheet = XLSX.utils.json_to_sheet(dataForSheet);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Resultados");
      
      // Ajusta a largura das colunas
      worksheet['!cols'] = [
        { wch: 30 }, // Paciente
        { wch: 30 }, // Empresa
        { wch: 20 }, // Sala
        { wch: 15 }, // Local
        { wch: 12 }, // Data
        { wch: 12 }, // Registro
        { wch: 12 }, // Início
        { wch: 12 }, // Fim
        { wch: 10 }, // Espera
        { wch: 10 }, // Duração
        { wch: 20 }, // Atendente
        { wch: 20 }  // NOVO CAMPO ASO Assinado
      ];

      const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });

      // 5. Envia o arquivo para o navegador
      res.setHeader('Content-Disposition', 'attachment; filename="relatorio_atendimentos.xlsx"');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.send(buffer);

  } catch (err) {
      logger.error("Erro ao exportar para XLSX:", err);
      res.status(500).send("Erro ao gerar o relatório.");
  }
});

// Rota para deletar entradas
app.post("/delete", auth, async (req, res) => {
  if (req.session.nivelAcesso !== 'admin') {
    logger.warn(`Tentativa de exclusão não autorizada pelo usuário: ${req.session.username}`);
    return res.redirect("/search");
  }

  let { deleteIds } = req.body;
  if (!deleteIds) {
    return res.redirect("/search");
  }

  if (!Array.isArray(deleteIds)) {
    deleteIds = [deleteIds];
  }

  try {
    // CORREÇÃO: Removido o .promise()
    const [rowsToDelete] = await db.query("SELECT * FROM atendimentos WHERE msgId IN (?)", [deleteIds]);

    if (rowsToDelete.length > 0) {
      const dadosRemovidosString = JSON.stringify(rowsToDelete);
      // CORREÇÃO: Removido o .promise()
      await db.query(
        'INSERT INTO log_deletes (username, dados_removidos) VALUES (?, ?)',
        [req.session.username, dadosRemovidosString]
      );
    }
    
    // CORREÇÃO: Removido o .promise()
    await db.query("DELETE FROM atendimentos WHERE msgId IN (?)", [deleteIds]);
    // CORREÇÃO: Removido o .promise()
    await db.query("DELETE FROM messages WHERE msgId IN (?)", [deleteIds]);
    
    res.redirect("/search");

  } catch (err) {
    logger.error("Erro no processo de exclusão:", err);
    return res.status(500).send("Erro ao excluir registros.");
  }
});

app.get("/trocar-senha", auth, exigirTrocaSenha, (req, res) => {
  const error = req.session.error;
  delete req.session.error;
  res.render("trocarSenha", { error });
});

app.post("/trocar-senha", auth, exigirTrocaSenha, async (req, res) => {
  const { novaSenha } = req.body;

  if (!novaSenha || novaSenha.length < 6) {
    req.session.error = "A senha deve ter ao menos 6 caracteres.";
    return res.redirect("/trocar-senha");
  }

  try {
    const hash = await bcrypt.hash(novaSenha, 10);
    
    // Mudar para await
    await db.query(
      "UPDATE usuarios SET password_hash = ?, senha_temporaria = FALSE WHERE id = ?",
      [hash, req.session.userId]
    );

    req.session.forcarTrocaSenha = false;
    res.redirect("/search");
    
  } catch (err) {
    // Note que o bcrypt.hash também pode dar erro, então o catch agora cobre ambos
    logger.error("Erro ao trocar senha:", err);
    req.session.error = "Erro interno ao processar sua solicitação.";
    return res.redirect("/trocar-senha");
  }
});

// Rota para exibir a página "Esqueci minha senha"
app.get('/esqueci-senha', (req, res) => {
  res.render('esqueciSenha', { message: null, error: null });
});

// Rota para processar a solicitação de redefinição de senha
app.post('/esqueci-senha', async (req, res) => {
  const { username } = req.body;
  const [users] = await db.query('SELECT * FROM usuarios WHERE username = ?', [username]);

  if (users.length === 0) {
    // Por segurança, não informamos que o e-mail não existe
    return res.render('esqueciSenha', { message: 'Se o e-mail estiver cadastrado, um link de recuperação foi enviado.', error: null });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiration = new Date();
  expiration.setHours(expiration.getHours() + 1); // Token expira em 1 hora

  await db.query('UPDATE usuarios SET reset_token = ?, reset_expira = ? WHERE username = ?', [token, expiration, username]);

  try {
    await sendPasswordResetEmail(username, token);
    res.render('esqueciSenha', { message: 'Um link de recuperação foi enviado para o seu e-mail.', error: null });
  } catch (error) {
    // --- SUBSTITUA SEU BLOCO CATCH POR ESTE ---
    logger.error({
        msg: "Detalhes do erro de envio de e-mail capturado",
        err: error,
        stack: error ? error.stack : 'Nenhum stack disponível'
    });
    console.log('--- DEBUG FINALIZADO ---');
    
    res.render('esqueciSenha', { message: null, error: 'Não foi possível enviar o e-mail. Contate o administrador.' });
    // ---------------------------------------------
  }
});

// Rota para exibir a página de redefinição de senha
app.get('/redefinir-senha', async (req, res) => {
  const { token } = req.query;
  const [users] = await db.query('SELECT * FROM usuarios WHERE reset_token = ? AND reset_expira > NOW()', [token]);

  if (users.length === 0) {
    return res.send('Token de redefinição inválido ou expirado.');
  }

  res.render('redefinirSenha', { token, error: null });
});

// Rota para processar a nova senha
app.post('/redefinir-senha', async (req, res) => {
  const { token, novaSenha, confirmarSenha } = req.body;

  if (novaSenha !== confirmarSenha) {
    return res.render('redefinirSenha', { token, error: 'As senhas não coincidem.' });
  }
  if (novaSenha.length < 6) {
    return res.render('redefinirSenha', { token, error: 'A senha deve ter no mínimo 6 caracteres.' });
  }

  const [users] = await db.query('SELECT * FROM usuarios WHERE reset_token = ? AND reset_expira > NOW()', [token]);

  if (users.length === 0) {
    return res.send('Token de redefinição inválido ou expirado.');
  }

  const newPasswordHash = await bcrypt.hash(novaSenha, 10);
  
  await db.query(
    'UPDATE usuarios SET password_hash = ?, senha_temporaria = FALSE, reset_token = NULL, reset_expira = NULL WHERE id = ?',
    [newPasswordHash, users[0].id]
  );
  
  // Redireciona para o login com uma mensagem de sucesso (opcional)
  res.redirect('/');
});

// 5. Inicialização do Servidor
app.listen(PORT, () => {
  logger.info(`Servidor web rodando em http://localhost:${PORT} (ou http://ipelabor.sytes.net:7000)`);
});