const fs = require('fs');
const path = require('path');
const P = require('pino');
const config = require('./config');

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

const logFile = path.join(logsDir, `wa-logs-${new Date().toISOString().slice(0, 10)}.log`);

const logLevel = config.logger?.level || 'info';

const logger = P({
    level: logLevel,
    transport: {
        targets: [
            {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'HH:MM:ss',
                    ignore: 'pid,hostname',
                    singleLine: false,
                    hideObject: false,
                }
            },
            {
                target: 'pino/file',
                options: { destination: logFile }
            }
        ]
    }
});

module.exports = logger;
