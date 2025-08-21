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

module.exports = { getBranchByChatId, getTopicsByBranch, normalizeText, normalizeAccents };