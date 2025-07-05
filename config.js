const fs = require('fs');
const ini = require('ini');
const path = require('path');

const configPath = path.join(__dirname, 'config.ini');
if (!fs.existsSync(configPath)) {
    logger.error('❌ Arquivo config.ini não encontrado.');
    process.exit(1);
}
const config = ini.parse(fs.readFileSync(configPath, 'utf-8'));
module.exports = config;