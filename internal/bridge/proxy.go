package bridge

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type proxyConfig struct {
	Enabled  bool   `json:"enabled"`
	Port     int    `json:"port"`
	BindHost string `json:"bindHost"`
	Token    string `json:"token,omitempty"`
}

func readProxyConfig(c config) (*proxyConfig, error) {
	path := filepath.Join(c.home, "proxy.json")
	ignored := func(reason string) (*proxyConfig, error) {
		fmt.Fprintf(os.Stderr, "browser-bridge: ignoring proxy config at %s: %s\n", path, reason)
		return nil, nil
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return ignored(err.Error())
	}
	raw, err := decodeObject(b)
	if err != nil {
		return ignored(err.Error())
	}
	if !raw.boolean("enabled") {
		return nil, nil
	}
	portText := raw.text("port")
	if portText == "" {
		portText = string(raw["port"])
	}
	portText = strings.TrimSpace(portText)
	port, err := strconv.Atoi(portText)
	if err != nil || strconv.Itoa(port) != portText || port < 1 || port > 65535 {
		return ignored("invalid port")
	}
	bindHost := "0.0.0.0"
	if host, exists := raw["bindHost"]; exists && string(host) != "null" {
		bindHost = strings.TrimSpace(raw.text("bindHost"))
	}
	if bindHost == "" || strings.ContainsAny(bindHost, " \t\r\n/\\") {
		return ignored("invalid bindHost")
	}
	return &proxyConfig{Enabled: true, Port: port, BindHost: bindHost, Token: raw.text("token")}, nil
}
func loopbackHost(host string) bool {
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	return host == "localhost" || net.ParseIP(host).IsLoopback()
}
func resolveProxySettings(existing *proxyConfig, args []string) (proxyConfig, error) {
	p := proxyConfig{Enabled: true, Port: 9223, BindHost: "127.0.0.1"}
	if existing != nil {
		p = *existing
		p.Enabled = true
	}
	explicitToken, rotate, unsafe, explicitBind := false, false, false, false
	seen := map[string]bool{}
	for i := 0; i < len(args); i++ {
		flag := args[i]
		if seen[flag] {
			return p, fmt.Errorf("duplicate proxy option %s", flag)
		}
		seen[flag] = true
		switch flag {
		case "--rotate-token":
			rotate = true
			continue
		case "--unsafe-plaintext":
			unsafe = true
			continue
		case "--port", "--bind-host", "--token":
		default:
			return p, fmt.Errorf("unknown proxy enable option %q", flag)
		}
		i++
		if i >= len(args) || strings.HasPrefix(args[i], "--") || strings.TrimSpace(args[i]) == "" {
			return p, fmt.Errorf("%s requires a value", flag)
		}
		switch flag {
		case "--port":
			n, e := strconv.Atoi(args[i])
			if e != nil || n < 1 || n > 65535 {
				return p, errors.New("port must be an integer between 1 and 65535")
			}
			p.Port = n
		case "--bind-host":
			p.BindHost = strings.Trim(args[i], "[]")
			explicitBind = true
		case "--token":
			p.Token = strings.TrimSpace(args[i])
			explicitToken = true
		}
	}
	if explicitToken && rotate {
		return p, errors.New("use either --token or --rotate-token, not both")
	}
	if strings.ContainsAny(p.BindHost, " \t\r\n/\\") {
		return p, errors.New("bind host must be a hostname or IP address")
	}
	if !loopbackHost(p.BindHost) && !unsafe && (explicitBind || existing == nil) {
		return p, errors.New("non-loopback raw TCP binds require --unsafe-plaintext; use a loopback bind with an SSH tunnel for encrypted transport")
	}
	if explicitToken && !tokenPattern.MatchString(p.Token) {
		return p, errors.New("invalid bridge auth token")
	}
	if rotate || !tokenPattern.MatchString(p.Token) {
		var b [32]byte
		if _, err := rand.Read(b[:]); err != nil {
			return p, err
		}
		p.Token = base64.RawURLEncoding.EncodeToString(b[:])
	}
	return p, nil
}
func handleProxyCommand(ctx context.Context, c config, args []string) error {
	if len(args) == 0 {
		return errors.New("usage: bbx proxy <enable|disable|status>")
	}
	existing, err := readProxyConfig(c)
	if err != nil {
		return err
	}
	path := filepath.Join(c.home, "proxy.json")
	switch args[0] {
	case "status":
		if len(args) != 1 {
			return errors.New("usage: bbx proxy status")
		}
		if existing == nil {
			fmt.Println("Browser Bridge proxy is disabled.")
			return nil
		}
		target := c
		target.network = "tcp"
		target.address = net.JoinHostPort("127.0.0.1", strconv.Itoa(existing.Port))
		state := "not reachable"
		if cl, e := connect(target, "agent"); e == nil {
			if _, e = invokeCLI(ctx, cl, nil, "health.ping", object{}); e == nil {
				state = "reachable"
			}
			cl.close()
		}
		fmt.Printf("Browser Bridge proxy is enabled on %s.\nConfig: %s\nDaemon: %s\n", net.JoinHostPort(existing.BindHost, strconv.Itoa(existing.Port)), path, state)
		return nil
	case "enable":
		p, err := resolveProxySettings(existing, args[1:])
		if err != nil {
			return err
		}
		if _, err = stopLocalDaemon(ctx, c); err != nil {
			return err
		}
		if err = writeCLIFile(c.agentToken, []byte(p.Token+"\n")); err != nil {
			return err
		}
		if err = writeCLIJSON(path, p); err != nil {
			return err
		}
		next, err := loadConfig()
		if err != nil {
			return err
		}
		if _, err = startLocalDaemon(ctx, next); err != nil {
			return err
		}
		fmt.Printf("Browser Bridge proxy enabled on %s.\nToken: %s\nConfig: %s\n", net.JoinHostPort(p.BindHost, strconv.Itoa(p.Port)), p.Token, path)
		return nil
	case "disable":
		if len(args) != 1 {
			return errors.New("usage: bbx proxy disable")
		}
		if _, err = stopLocalDaemon(ctx, c); err != nil {
			return err
		}
		if err = os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		next, err := loadConfig()
		if err != nil {
			return err
		}
		if _, err = startLocalDaemon(ctx, next); err != nil {
			return err
		}
		fmt.Println("Browser Bridge proxy disabled. Daemon restarted.")
		return nil
	}
	return errors.New("usage: bbx proxy <enable|disable|status>")
}
func handleConfigCommand(c config, args []string) error {
	if len(args) < 2 || args[1] != "auto-update" || (args[0] != "get" && args[0] != "set") || (args[0] == "get" && len(args) != 2) || (args[0] == "set" && len(args) != 3) {
		return errors.New("usage: bbx config <get auto-update|set auto-update off|compatible>")
	}
	path := filepath.Join(c.home, "config.json")
	settings := object{}
	b, err := os.ReadFile(path)
	if err == nil {
		settings, err = decodeObject(b)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	policy := settings.text("autoUpdate")
	if policy == "" {
		policy = "off"
	}
	if args[0] == "set" {
		policy = args[2]
	} else if env, ok := os.LookupEnv("BBX_AUTO_UPDATE"); ok {
		policy = env
	}
	if policy != "off" && policy != "compatible" {
		return errors.New("auto-update policy must be off or compatible")
	}
	if args[0] == "get" {
		fmt.Println(policy)
		return nil
	}
	settings["autoUpdate"] = value(policy)
	if err := writeCLIJSON(path, settings); err != nil {
		return err
	}
	fmt.Printf("Browser Bridge auto-update policy set to %q.\nConfig: %s\n", policy, path)
	return nil
}
