#!/bin/sh
set -e
# 先放行本机回环（含 Docker DNS 127.0.0.11），再拒绝内网和元数据。
# 公网目标地址不在这些网段里，仍然可以出去。
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -d 0.0.0.0/8 -j REJECT
iptables -A OUTPUT -d 10.0.0.0/8 -j REJECT
iptables -A OUTPUT -d 100.64.0.0/10 -j REJECT
iptables -A OUTPUT -d 127.0.0.0/8 -j REJECT
iptables -A OUTPUT -d 169.254.0.0/16 -j REJECT
iptables -A OUTPUT -d 172.16.0.0/12 -j REJECT
iptables -A OUTPUT -d 192.168.0.0/16 -j REJECT
iptables -A OUTPUT -d 255.255.255.255/32 -j REJECT
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -A OUTPUT -o lo -j ACCEPT || true
  ip6tables -A OUTPUT -d ::1/128 -j REJECT || true
  ip6tables -A OUTPUT -d fc00::/7 -j REJECT || true
  ip6tables -A OUTPUT -d fe80::/10 -j REJECT || true
fi
exec python -c 'import os; os.setgid(1000); os.setuid(1000); os.execvp("sleep", ["sleep", "infinity"])'
