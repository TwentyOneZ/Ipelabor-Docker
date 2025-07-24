// server.js

// 1. Importações
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const path = require("path");
const mysql = require("mysql2");
const fs = require("fs");
const ini = require("ini");
const bcrypt = require('bcrypt');
const logger = require('./logger');
const crypto = require('crypto');

// 2. Inicialização do App
const app = express();
const PORT = 3000;

// Leitura do config.ini
const config = ini.parse(
  fs.readFileSync(path.join(__dirname, "../config.ini"), "utf-8")
);
const db = mysql.createConnection({
  host: config.mysql.host,
  port: config.mysql.port,
  user: config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database
});


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


app.post("/login", (req, res) => {
  const { username, password } = req.body;

  db.query(
    "SELECT id, username, password_hash, nivel_acesso, restricoes, senha_temporaria, empresa FROM usuarios WHERE username = ? LIMIT 1",
    [username],
    async (err, results) => {
      if (err) {
        logger.error("Erro ao consultar usuários:", err);
        req.session.error = "Erro interno.";
        return res.redirect("/");
      }

      if (results.length === 0) {
        req.session.error = "Usuário ou senha inválidos.";
        return res.redirect("/");
      }

      const user = results[0];

      try {
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

        // Se senha é temporária → força troca
        if (user.senha_temporaria) {
          req.session.forcarTrocaSenha = true;
          return res.redirect("/trocar-senha");
        }

        return res.redirect("/search");
      } catch (bcryptErr) {
        logger.error("Erro ao comparar senha:", bcryptErr);
        req.session.error = "Erro interno.";
        return res.redirect("/");
      }
    }
  );
});

// GET / → login page
app.get("/", (req, res) => {
  // lê e apaga a mensagem de erro (flash)
  const error = req.session.error;
  delete req.session.error;

  res.render("login", { error });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === USER && password === PASSWORD) {
    req.session.loggedIn = true;
    return res.redirect("/search");
  }
  // falhou: guarda mensagem de erro e redireciona
  req.session.error = "Credenciais inválidas.";
  res.redirect("/");
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

app.post("/search", auth, (req, res) => {
  const {
    name      = '',
    empresa   = '',
    sala      = '',
    branch    = '',
    caller    = '',
    startDate = '',
    endDate   = ''
  } = req.body;

  // POST /delete → exclui seleções
  app.post("/delete", auth, (req, res) => {
    if (req.session.nivelAcesso !== 'admin') {
      logger.warn(`Tentativa de exclusão não autorizada pelo usuário: ${req.session.username}`);
      // Apenas redireciona de volta, sem dar feedback do erro
      return res.redirect("/search");
    }

    let { deleteIds } = req.body;
    if (!deleteIds) {
      return res.redirect("/search");
    }
    // garante array
    if (!Array.isArray(deleteIds)) {
      deleteIds = [ deleteIds ];
    }
    // 1) apaga de atendimentos
    db.query(
      "DELETE FROM atendimentos WHERE msgId IN (?)",
      [ deleteIds ],
      (err) => {
        if (err) {
          logger.error("Erro ao excluir atendimentos:", err);
          return res.status(500).send("Erro ao excluir atendimentos.");
        }
        // 2) apaga de messages
        db.query(
          "DELETE FROM messages WHERE msgId IN (?)",
          [ deleteIds ],
          (err2) => {
            if (err2) {
              logger.error("Erro ao excluir messages:", err2);
              return res.status(500).send("Erro ao excluir mensagens.");
            }
            // redireciona mantendo filtros zerados (ou você pode levar via querystring)
            res.redirect("/search");
          }
        );
      }
    );
  });
  
  const sortBy  = req.body.sortBy  || 'data';
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
      caller
    FROM atendimentos
    ${where}
    ORDER BY \`${sortBy}\` ${sortDir}
  `;

  db.query(sql, params, (err, results) => {
    if (err) {
      logger.error(err);
      return res.status(500).send("Erro no banco de dados.");
    }
    res.render("search", {
      results,
      filters: { name, empresa, sala, branch, startDate, endDate, caller },
      sorting: { sortBy, sortDir },
      nivelAcesso: req.session.nivelAcesso
    });
  });
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
    db.query(
      "UPDATE usuarios SET password_hash = ?, senha_temporaria = FALSE WHERE id = ?",
      [hash, req.session.userId],
      (err) => {
        if (err) {
          logger.error("Erro ao atualizar senha:", err);
          req.session.error = "Erro interno.";
          return res.redirect("/trocar-senha");
        }

        req.session.forcarTrocaSenha = false;
        res.redirect("/search");
      }
    );
  } catch (err) {
    logger.error("Erro no hash da nova senha:", err);
    req.session.error = "Erro interno.";
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
  const [users] = await db.promise().query('SELECT * FROM usuarios WHERE username = ?', [username]);

  if (users.length === 0) {
    // Por segurança, não informamos que o e-mail não existe
    return res.render('esqueciSenha', { message: 'Se o e-mail estiver cadastrado, um link de recuperação foi enviado.', error: null });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiration = new Date();
  expiration.setHours(expiration.getHours() + 1); // Token expira em 1 hora

  await db.promise().query('UPDATE usuarios SET reset_token = ?, reset_expira = ? WHERE username = ?', [token, expiration, username]);

  try {
    await sendPasswordResetEmail(username, token);
    res.render('esqueciSenha', { message: 'Um link de recuperação foi enviado para o seu e-mail.', error: null });
  } catch (error) {
    // --- SUBSTITUA SEU BLOCO CATCH POR ESTE ---
    console.log('--- DEBUG INICIADO: OCORREU UM ERRO NO ENVIO DE EMAIL ---');
    console.log('Tipo do erro:', typeof error);
    console.log('Erro como string:', String(error));
    console.log('Erro como JSON:', JSON.stringify(error, null, 2));
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
  const [users] = await db.promise().query('SELECT * FROM usuarios WHERE reset_token = ? AND reset_expira > NOW()', [token]);

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

  const [users] = await db.promise().query('SELECT * FROM usuarios WHERE reset_token = ? AND reset_expira > NOW()', [token]);

  if (users.length === 0) {
    return res.send('Token de redefinição inválido ou expirado.');
  }

  const newPasswordHash = await bcrypt.hash(novaSenha, 10);
  
  await db.promise().query(
    'UPDATE usuarios SET password_hash = ?, senha_temporaria = FALSE, reset_token = NULL, reset_expira = NULL WHERE id = ?',
    [newPasswordHash, users[0].id]
  );
  
  // Redireciona para o login com uma mensagem de sucesso (opcional)
  res.redirect('/');
});

// 5. Inicialização do Servidor
app.listen(PORT, () => {
  logger.info(`Servidor web rodando em http://localhost:${PORT}`);
});