// scraper/config.js
const fs = require('fs');
const ini = require('ini');
const path = require('path');

// O arquivo config.ini está um nível acima da pasta scraper/
const configPath = path.join(__dirname, '..', 'config.ini')

if (!fs.existsSync(configPath)) {
    // Não podemos usar o logger aqui, pois ele depende deste config.js
    console.error('❌ Arquivo config.ini não encontrado no caminho esperado:', configPath);
    process.exit(1);
}

const config = ini.parse(fs.readFileSync(configPath, 'utf-8'));
module.exports = config;