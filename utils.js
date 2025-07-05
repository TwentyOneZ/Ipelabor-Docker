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

module.exports = { getBranchByChatId, getTopicsByBranch };