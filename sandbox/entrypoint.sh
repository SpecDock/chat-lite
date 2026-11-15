#!/bin/sh
set -eu
# Every stop/start reuses this namespace: firewall initialization is idempotent.
# Both Docker sysctls and a fail-closed IPv6 DROP policy are mandatory.
test "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6)" = 1
test "$(cat /proc/sys/net/ipv6/conf/default/disable_ipv6)" = 1
ip6tables -P OUTPUT DROP
ip6tables -F OUTPUT
iptables -P OUTPUT DROP
iptables -F OUTPUT
# Docker v28.5.2 libnetwork/resolver_unix.go setupIptablesNAT DNATs
# 127.0.0.11:53 to a dynamic listener port before filter OUTPUT, and
# restores the reply source port in POSTROUTING. Match the conntrack
# ORIGINAL destination tuple in BOTH directions, not packet --dport/sport.
# Only this TCP/UDP DNS connection on lo bypasses the loopback rejection;
# there is no general loopback or ESTABLISHED exception.
for protocol in udp tcp; do
  iptables -A OUTPUT -o lo -p "$protocol" -m conntrack --ctdir ORIGINAL --ctorigdst 127.0.0.11 --ctorigdstport 53 --ctstate NEW,ESTABLISHED -j ACCEPT
  iptables -A OUTPUT -o lo -p "$protocol" -m conntrack --ctdir REPLY --ctorigdst 127.0.0.11 --ctorigdstport 53 --ctstate ESTABLISHED -j ACCEPT
done
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  iptables -A OUTPUT -d "$cidr" -j REJECT
done
# Literal IPv4 argv comes only from the trusted broker, never model env/config.
test "$#" -gt 0
for address in "$@"; do
  iptables -A OUTPUT -d "$address/32" -j REJECT
done
iptables -A OUTPUT -j ACCEPT
# Models get no permitted/effective/inheritable/ambient capabilities, and NNP.
exec setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all --ambient-caps=-all --no-new-privs sleep infinity
