package authsec

import (
	"crypto/tls"
	"fmt"
	"log"
	"net"
	"net/smtp"
	"os"
	"strconv"
	"strings"
)

func SendEmailCode(email, code, purpose string) error {
	host := os.Getenv("SMTP_HOST")
	user := os.Getenv("SMTP_USER")
	pass := os.Getenv("SMTP_PASS")
	from := os.Getenv("SMTP_FROM")
	if from == "" {
		from = "Chat Lite <no-reply@example.com>"
	}
	port := 587
	if raw := os.Getenv("SMTP_PORT"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			port = n
		}
	}
	subject, text := emailContent(purpose, code)
	if host == "" || user == "" || pass == "" {
		log.Printf("[dev email code] %s: %s", email, code)
		return nil
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	serverName := os.Getenv("SMTP_TLS_SERVERNAME")
	if serverName == "" {
		serverName = host
	}
	msg := []byte("From: " + from + "\r\nTo: " + email + "\r\nSubject: " + subject + "\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n" + text)
	auth := smtp.PlainAuth("", user, pass, host)
	var err error
	if port == 465 {
		err = sendImplicitTLS(addr, serverName, auth, fromAddr(from), []string{email}, msg)
	} else {
		err = smtp.SendMail(addr, auth, fromAddr(from), []string{email}, msg)
	}
	if err != nil {
		return fmt.Errorf("邮件发送失败：%s", err.Error())
	}
	return nil
}

func emailContent(purpose, code string) (string, string) {
	switch purpose {
	case "password_reset":
		return "chat-lite 重置密码验证码", "你正在重置 Chat Lite 密码。验证码：" + code + "，10 分钟内有效。如非本人操作，请忽略此邮件。"
	case "password_change":
		return "chat-lite 修改密码验证码", "你正在修改 Chat Lite 密码。验证码：" + code + "，10 分钟内有效。如非本人操作，请忽略此邮件。"
	default:
		return "chat-lite 注册验证码", "验证码：" + code + "，10 分钟内有效。"
	}
}

func fromAddr(from string) string {
	if i := strings.LastIndex(from, "<"); i >= 0 && strings.HasSuffix(from, ">") {
		return strings.TrimSpace(from[i+1 : len(from)-1])
	}
	return from
}

func sendImplicitTLS(addr, serverName string, auth smtp.Auth, from string, to []string, msg []byte) error {
	conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: serverName})
	if err != nil {
		return err
	}
	defer conn.Close()
	client, err := smtp.NewClient(conn, serverName)
	if err != nil {
		return err
	}
	defer client.Close()
	if err = client.Auth(auth); err != nil {
		return err
	}
	if err = client.Mail(from); err != nil {
		return err
	}
	for _, rcpt := range to {
		if err = client.Rcpt(rcpt); err != nil {
			return err
		}
	}
	w, err := client.Data()
	if err != nil {
		return err
	}
	if _, err = w.Write(msg); err != nil {
		return err
	}
	if err = w.Close(); err != nil {
		return err
	}
	return client.Quit()
}
