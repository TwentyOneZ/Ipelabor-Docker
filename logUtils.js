const logger = require('./logger');
const config = require('./config');
const { getBranchByChatId } = require('./utils');

const verbose = Number(config.logger?.verbose) || 0;

function logMessage(chatId, text, isReaction = false, emoji = '📩') {
    if (verbose === 0) return;

    const branch = getBranchByChatId(chatId);
    const sala = config.rooms?.[chatId];

    const isGroup = branch !== null && sala !== undefined;

    let prefix = emoji;
    let message = '';

    if (verbose === 1) {
        if (!isGroup) return;
        message = `${prefix} ${sala} - ${capitalize(branch)}`;
    } 
    else if (verbose === 2) {
        if (!isGroup) return;
        message = `${prefix} ${sala} - ${capitalize(branch)}: "${text}"`;
    }
    else if (verbose === 3) {
        message = `${prefix} ${sala ? sala : chatId}${branch ? ' - ' + capitalize(branch) : ''}: "${text}"`;
    }

    logger.info(message);
}

function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = { logMessage };
