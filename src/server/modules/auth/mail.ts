import nodemailer from 'nodemailer';

export async function sendEmailCode(email: string, code: string) {
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
    await transporter.sendMail({ from, to: email, subject: 'chat-lite 注册验证码', text: `验证码：${code}，10 分钟内有效。` });
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    throw new Error(`邮件发送失败：${message}`);
  }
}
