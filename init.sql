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
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  nivel_acesso TINYINT NOT NULL CHECK (nivel_acesso IN (1,2,3)),
  restricoes JSON NULL, -- usado apenas se nível_acesso = 3
  reset_token VARCHAR(100) NULL,
  reset_expires DATETIME NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
