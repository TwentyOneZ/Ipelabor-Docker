// web/email.js
const nodemailer = require('nodemailer');
const config = require('../config'); // Usará o config.ini

// ATENÇÃO: Adicione uma seção [smtp] ao seu arquivo config.ini
const transporter = nodemailer.createTransport({
  host: config.smtp.host,       // Ex: smtp.gmail.com
  port: config.smtp.port,       // Ex: 587
  secure: config.smtp.port == 465, // true para porta 465, false para outras
  auth: {
    user: config.smtp.user,     // Seu e-mail
    pass: config.smtp.password  // Sua senha de e-mail ou senha de app
  }
});

async function sendPasswordResetEmail(to, token) {
  const resetLink = `http://localhost:7000/redefinir-senha?token=${token}`;
  
  const mailOptions = {
    from: `"Sistema Ipêlabor" <${config.smtp.user}>`,
    to: to,
    subject: 'Redefinição de Senha',
    html: `
      <p>Olá!</p>
      <p></p>
      <p>Parece que você solicitou a redefinição da sua senha, certo?</p>
      <p>Clique no link a seguir para criar uma nova senha:</p>
      <a href="${resetLink}">${resetLink}</a>
      <p>Este link irá expirar em 1 hora.</p>
      <p></p>
      <p>Se não funcionar, responda este email ou me contate no Whatsapp: 62 985993737.</p>
      <p></p>
      <p>Um abraço!</p>
      <p></p>
      <p>--</p>
      <p>Gustavo Souza</p>
    `
  };

  await transporter.sendMail(mailOptions);
}

module.exports = { sendPasswordResetEmail };