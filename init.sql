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
    caller VARCHAR(255)
);
