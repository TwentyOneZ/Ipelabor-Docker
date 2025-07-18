// server.js

const express    = require("express");
const session    = require("express-session");
const bodyParser = require("body-parser");
const path       = require("path");
const mysql      = require("mysql2");
const fs         = require("fs");
const ini        = require("ini");
const logger     = require('../logger');

const app  = express();
const PORT = 3000;

// Leitura do config.ini
const config = ini.parse(
  fs.readFileSync(path.join(__dirname, "../config.ini"), "utf-8")
);
const db = mysql.createConnection({
  host:     config.mysql.host,
  port:     config.mysql.port,
  user:     config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database
});

const USER     = "admin";
const PASSWORD = "q1w2e3";

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

function auth(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect("/");
}

// helper para data de hoje no formato YYYY-MM-DD
function todayISO() {
  const d  = new Date();
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dt = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dt}`;
}

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
    sorting: { sortBy: "data", sortDir: "DESC" }
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
      sorting: { sortBy, sortDir }
    });
  });
});

app.listen(PORT, () => {
  logger.info(`Servidor rodando em http://ipelabor.sytes.net:7000 (http://localhost:${PORT})`);
});
