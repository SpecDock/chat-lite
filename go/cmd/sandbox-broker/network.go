package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"time"
)

// Operator-supplied deployment public/NAT service addresses. Host interfaces
// and routes supplement them. No third-party public-IP HTTP discovery occurs.
// Update this trusted list before moving a NAT-backed deployment elsewhere.
var deploymentHostIPs = []string{"47.108.232.215", "182.61.144.18"}

func (e *engine) hostAddresses(parent context.Context) (addresses []string, retErr error) {
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	defer cancel()
	// Trusted short-lived host-net probe: no mounts, socket or extra capability.
	spec := sandboxSpec("probe")
	spec.Cmd = []string{"sleep", "20"}
	spec.HostConfig.NetworkMode = "host"
	spec.HostConfig.Binds = nil
	spec.HostConfig.Tmpfs = nil
	spec.HostConfig.Ulimits = nil
	name := fmt.Sprintf("chatlite-probe-%d", e.seq.Add(1))
	var created struct {
		ID string `json:"Id"`
	}
	if err := e.do(ctx, http.MethodPost, apiPrefix+"/containers/create?name="+url.QueryEscape(name), spec, &created); err != nil {
		return nil, fmt.Errorf("create trusted host-network probe (build chat-lite-table-sandbox first): %w", err)
	}
	if !refPattern.MatchString(created.ID) {
		return nil, errors.New("invalid probe container id")
	}
	defer func() {
		clean, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if err := e.forceRemove(clean, created.ID); err != nil {
			addresses = nil
			retErr = fmt.Errorf("remove host probe: %w", err)
		}
	}()
	if err := e.start(ctx, created.ID); err != nil {
		return nil, err
	}
	script := `import json,subprocess
a=json.loads(subprocess.check_output(['ip','-j','-4','address','show']))
r=json.loads(subprocess.check_output(['ip','-j','-4','route','show','table','all']))
ips=[x['local'] for dev in a for x in dev.get('addr_info',[]) if x.get('family')=='inet']
ips += [x['gateway'] for x in r if 'gateway' in x]
print(json.dumps(ips))`
	out, errout, code, truncated, err := e.execCapture(ctx, created.ID, []string{"python", "-I", "-B", "-c", script}, "/", 16384)
	if err != nil {
		return nil, err
	}
	if code != 0 || truncated {
		return nil, fmt.Errorf("host interface/route probe failed: %s", errout)
	}
	var discovered []string
	if err = json.Unmarshal([]byte(out), &discovered); err != nil {
		return nil, fmt.Errorf("invalid host probe: %w", err)
	}
	if len(discovered) == 0 {
		return nil, errors.New("no trusted host interface/route evidence; egress isolation refused")
	}
	unique := map[string]bool{}
	for _, value := range append(discovered, deploymentHostIPs...) {
		ip := net.ParseIP(value)
		if ip == nil || ip.To4() == nil {
			return nil, errors.New("invalid IPv4 in host isolation evidence")
		}
		unique[ip.To4().String()] = true
	}
	for ip := range unique {
		addresses = append(addresses, ip)
	}
	sort.Strings(addresses)
	return addresses, nil
}
