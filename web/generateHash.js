// generateHash.js
const bcrypt = require('bcryptjs');

const plaintextPassword = '01234567'; // Senha padrão
const saltRounds = 10;

bcrypt.hash(plaintextPassword, saltRounds, (err, hash) => {
  if (err) {
    console.error('Erro ao gerar o hash:', err);
    return;
  }
  console.log('--- Hash Gerado ---');
  console.log(hash);
  console.log('\n--- Comando SQL para Atualizar ---');
  console.log(`UPDATE usuarios SET password_hash = '${hash}', senha_temporaria = FALSE;`);
});