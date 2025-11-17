// scraper/logger.js

// Logger hiper simples só para debug no Docker
function formatPrefix(level) {
    const ts = new Date().toISOString();
    return `[${ts}] [${level.toUpperCase()}]`;
  }
  
  const logger = {
    info: (...args) => {
      console.log(formatPrefix('info'), ...args);
    },
    error: (...args) => {
      console.error(formatPrefix('error'), ...args);
    },
    warn: (...args) => {
      console.warn(formatPrefix('warn'), ...args);
    },
    debug: (...args) => {
      console.log(formatPrefix('debug'), ...args);
    }
  };
  
  module.exports = logger;
  