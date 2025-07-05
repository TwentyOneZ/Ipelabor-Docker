const mysql = require('mysql2/promise');
const config = require('./config');
const logger = require('./logger');

let pool;

async function connectMySQL() {
    pool = mysql.createPool({
        host: config.mysql.host,
        user: config.mysql.user,
        password: config.mysql.password,
        database: config.mysql.database,
        waitForConnections: true,
        connectionLimit: 10
    });
    logger.info('✅ Banco MySQL conectado!');
    return pool;
}

function getPool() {
    if (!pool) throw new Error('MySQL não conectado');
    return pool;
}

module.exports = { connectMySQL, getPool };
