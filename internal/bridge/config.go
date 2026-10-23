package bridge

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var version = "0.0.0-dev"
var buildTarget = "development"

const hostName = "com.browserbridge.browser_bridge"

type config struct {
	home       string
	network    string
	address    string
	bind       string
	agentToken string
	token      string // Explicit destination credential; never inherited by another client.
	remote     bool
}

func loadConfig() (config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return config{}, err
	}
	bridgeHome := os.Getenv("BROWSER_BRIDGE_HOME")
	if bridgeHome == "" {
		switch runtime.GOOS {
		case "darwin":
			bridgeHome = filepath.Join(home, "Library", "Application Support", "Browser Bridge")
		case "windows":
			local := os.Getenv("LOCALAPPDATA")
			if local == "" {
				local = filepath.Join(home, "AppData", "Local")
			}
			bridgeHome = filepath.Join(local, "Browser Bridge")
		default:
			data := os.Getenv("XDG_DATA_HOME")
			if data == "" {
				data = filepath.Join(home, ".local", "share")
			}
			bridgeHome = filepath.Join(data, "browser-bridge")
		}
	}
	c := config{home: bridgeHome, network: "unix", address: filepath.Join(bridgeHome, "bridge.sock")}
	proxy, err := readProxyConfig(c)
	if err != nil {
		return c, err
	}
	c.agentToken = os.Getenv("BBX_AUTH_TOKEN_FILE")
	if c.agentToken == "" {
		c.agentToken = filepath.Join(bridgeHome, "daemon.auth")
	}
	port := strings.TrimSpace(os.Getenv("BBX_TCP_PORT"))
	if port == "" && proxy != nil {
		c.network = "tcp"
		c.address = net.JoinHostPort("127.0.0.1", strconv.Itoa(proxy.Port))
		c.bind = net.JoinHostPort(proxy.BindHost, strconv.Itoa(proxy.Port))
		return c, nil
	}
	if port == "" && runtime.GOOS == "windows" {
		if os.Getenv("BROWSER_BRIDGE_HOME") != "" {
			c.network, c.address = "pipe", windowsPipeAddress(bridgeHome)
			c.bind = c.address
			return c, nil
		}
		port = "9223"
	}
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != port {
			return c, errors.New("BBX_TCP_PORT must be an integer between 1 and 65535")
		}
		host := os.Getenv("BBX_TCP_HOST")
		if host == "" {
			host = "127.0.0.1"
		}
		host = strings.TrimSpace(host)
		if host == "" || strings.ContainsAny(host, " \t\r\n/\\") {
			return c, errors.New("BBX_TCP_HOST must be a hostname or IP address")
		}
		bind := os.Getenv("BBX_TCP_BIND_HOST")
		if bind == "" {
			bind = host
		}
		bind = strings.TrimSpace(bind)
		if bind == "" || strings.ContainsAny(bind, " \t\r\n/\\") {
			return c, errors.New("BBX_TCP_BIND_HOST must be a hostname or IP address")
		}
		c.network, c.address, c.bind = "tcp", net.JoinHostPort(host, port), net.JoinHostPort(bind, port)
	} else {
		c.bind = c.address
	}
	return c, nil
}

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32,256}$`)

func storedToken(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(b))
	if !tokenPattern.MatchString(token) {
		return "", fmt.Errorf("invalid bridge credential in %s", path)
	}
	return token, nil
}

func (c config) credential(role string) (string, error) {
	if role == "extension" {
		return storedToken(filepath.Join(c.home, "daemon.extension.auth"))
	}
	if c.token != "" {
		return c.token, nil
	}
	if token := strings.TrimSpace(os.Getenv("BBX_AUTH_TOKEN")); token != "" {
		if !tokenPattern.MatchString(token) {
			return "", errors.New("invalid BBX_AUTH_TOKEN")
		}
		return token, nil
	}
	return storedToken(c.agentToken)
}

func tokensEqual(a, b string) bool {
	return a != "" && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// Publish a complete token without overwriting a concurrent winner or an
// existing invalid credential. Node and Go daemons share these same files.
func ensureToken(path string) (string, error) {
	if token, err := storedToken(path); err == nil || !errors.Is(err, os.ErrNotExist) {
		return token, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(bytes[:])
	temporary := path + "." + uniqueID() + ".tmp"
	if err := os.WriteFile(temporary, []byte(token+"\n"), 0600); err != nil {
		return "", err
	}
	defer func() { _ = os.Remove(temporary) }()
	if err := os.Link(temporary, path); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	return storedToken(path)
}

func (c config) dial() (net.Conn, error) {
	return dialTransport(c.network, c.address, 3*time.Second)
}
