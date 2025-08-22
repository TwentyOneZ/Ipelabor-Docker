const config = require('./config');

function getBranchByChatId(chatId) {
    for (const [branch, chatList] of Object.entries(config.branches)) {
        const chats = chatList.split(',').map(e => e.trim());
        if (chats.includes(chatId)) return branch;
    }
    return null;
}

function getTopicsByBranch(branch) {
    const name = config.branch_names?.[branch] || branch;
    return {
        topicMessages: `${name}${config.topics?.messages || '/painel/messages'}`,
        topicReactionsRaw: `${name}${config.topics?.reactions || '/painel/reactions'}`,
        topicCalls: `${name}${config.topics?.calls || '/painel/calls'}`
    };
}

function normalizeAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeText(text) {
  // ➊ remove asteriscos e o sufixo " ASSINA ✅"
  let t = text.replace(/\*/g, '').replace(/\s*ASSINAR\s*/g, '').replace(/\s*ASSINA\s*/g, '').replace(/\s*✅\s*/g, '');

  // remove espaços iniciais
  t = t.trimStart();

  // testa "não-alfaNumérico* + hífen"
  if (/^[^A-Za-z0-9]+-/.test(t)) {
    // remove até (e incluindo) o primeiro hífen
    t = t.replace(/^[^A-Za-z0-9]+-/, '');
  }

  return t.trim();
}

/**
 * Calcula a Distância de Levenshtein entre duas strings.
 * Fonte: https://en.wikipedia.org/wiki/Levenshtein_distance
 */
function calculateLevenshteinDistance(a, b) {
  const an = a.length;
  const bn = b.length;
  if (an === 0) return bn;
  if (bn === 0) return an;

  const matrix = [];

  for (let i = 0; i <= an; i++) {
    matrix[i] = [i];
  }
  for (let j = 1; j <= bn; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= an; i++) {
    for (let j = 1; j <= bn; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // Exclusão
        matrix[i][j - 1] + 1, // Inserção
        matrix[i - 1][j - 1] + cost // Substituição
      );
    }
  }
  return matrix[an][bn];
}

module.exports = { getBranchByChatId, getTopicsByBranch, normalizeText, normalizeAccents, calculateLevenshteinDistance };