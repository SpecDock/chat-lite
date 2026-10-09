import nodemailer from 'nodemailer';

export type EmailCodePurpose = 'register' | 'password_reset' | 'password_change';

function emailContent(purpose: EmailCodePurpose) {
  if (purpose === 'password_reset') return { subject: 'chat-lite 重置密码验证码', text: '你正在重置 Chat Lite 密码。验证码：{code}，10 分钟内有效。如非本人操作，请忽略此邮件。' };
  if (purpose === 'password_change') return { subject: 'chat-lite 修改密码验证码', text: '你正在修改 Chat Lite 密码。验证码：{code}，10 分钟内有效。如非本人操作，请忽略此邮件。' };
  return { subject: 'chat-lite 注册验证码', text: '验证码：{code}，10 分钟内有效。' };
}

export async function sendEmailCode(email: string, code: string, purpose: EmailCodePurpose = 'register') {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || 'Chat Lite <no-reply@example.com>';
  const port = Number(process.env.SMTP_PORT || 587);
  if (!host || !user || !pass) {
    console.log(`[dev email code] ${email}: ${code}`);
    return;
  }
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { servername: process.env.SMTP_TLS_SERVERNAME || host },
    connectionTimeout: 12_000,
    greetingTimeout: 12_000,
    socketTimeout: 20_000
  });
  try {
    const content = emailContent(purpose);
    await transporter.sendMail({ from, to: email, subject: content.subject, text: content.text.replace('{code}', code) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    throw new Error(`邮件发送失败：${message}`);
  }
}
