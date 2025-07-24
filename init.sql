USE ipelabor;

CREATE TABLE IF NOT EXISTS messages (
    msgId VARCHAR(255) PRIMARY KEY,
    chatId VARCHAR(255),
    branch VARCHAR(255),         -- 🆕 Nome da branch (ex.: matriz, t63)
    text TEXT,
    fromMe BOOLEAN,
    participant VARCHAR(255),
    `timestamp` DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_messages_chat_ts (chatId, `timestamp`)
);

CREATE TABLE IF NOT EXISTS atendimentos (
    msgId VARCHAR(255) PRIMARY KEY,
    paciente VARCHAR(255),
    empresa VARCHAR(255),
    sala VARCHAR(255),
    branch VARCHAR(255),
    `data` DATE,
    hora_registro TIME,
    hora_inicio TIME,
    hora_fim TIME,
    espera VARCHAR(50),
    duracao VARCHAR(50),
    caller VARCHAR(255),
    INDEX idx_atend_sala_fim_inicio (sala, hora_fim, hora_inicio DESC)
);

CREATE TABLE usuarios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  nivel_acesso ENUM('admin', 'colaborador', 'empresa') NOT NULL DEFAULT 'colaborador',
  empresa VARCHAR(255) DEFAULT NULL, -- só será usado se nivel_acesso = 'empresa'
  restricoes TEXT DEFAULT NULL,
  senha_temporaria BOOLEAN DEFAULT TRUE,
  reset_token VARCHAR(255) DEFAULT NULL,
  reset_expira DATETIME DEFAULT NULL
);