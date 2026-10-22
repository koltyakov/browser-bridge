package bridge

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type remoteDestination struct {
	ID    string `json:"id"`
	Host  string `json:"host"`
	Port  int    `json:"port"`
	Token string `json:"token"`
}
type remoteConfig struct {
	Remotes []remoteDestination `json:"remotes"`
}

var remoteNamePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

func normalizeDestinationID(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "local" || !remoteNamePattern.MatchString(name) {
		return "", errors.New("remote name must be 1-64 letters, numbers, dots, dashes, or underscores")
	}
	return name, nil
}
func parseRemoteEndpoint(endpoint string) (string, int, error) {
	endpoint = strings.TrimSpace(endpoint)
	host, port := endpoint, 9223
	if strings.HasPrefix(endpoint, "[") {
		if strings.HasSuffix(endpoint, "]") {
			host = strings.Trim(endpoint, "[]")
		} else {
			h, p, e := net.SplitHostPort(endpoint)
			if e != nil {
				return "", 0, e
			}
			host = h
			port, e = strconv.Atoi(p)
			if e != nil {
				return "", 0, e
			}
		}
	} else if strings.Count(endpoint, ":") == 1 {
		parts := strings.SplitN(endpoint, ":", 2)
		host = parts[0]
		var e error
		port, e = strconv.Atoi(parts[1])
		if e != nil {
			return "", 0, errors.New("remote port must be an integer between 1 and 65535")
		}
	} else if strings.Contains(endpoint, ":") && net.ParseIP(endpoint) == nil {
		return "", 0, errors.New("IPv6 endpoints with ports must use brackets")
	}
	if host == "" || strings.ContainsAny(host, " \t\r\n/\\") {
		return "", 0, errors.New("remote host must be a hostname or IP address")
	}
	if port < 1 || port > 65535 {
		return "", 0, errors.New("remote port must be an integer between 1 and 65535")
	}
	return host, port, nil
}
func readRemoteConfig(c config) (remoteConfig, error) {
	result := remoteConfig{Remotes: []remoteDestination{}}
	b, err := os.ReadFile(filepath.Join(c.home, "remotes.json"))
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	var raw struct {
		Remotes []json.RawMessage `json:"remotes"`
	}
	if err = json.Unmarshal(b, &raw); err != nil {
		return result, err
	}
	for _, entry := range raw.Remotes {
		var remote remoteDestination
		if json.Unmarshal(entry, &remote) != nil {
			continue
		}
		id, e := normalizeDestinationID(remote.ID)
		if e != nil || !tokenPattern.MatchString(strings.TrimSpace(remote.Token)) {
			continue
		}
		host, port, e := parseRemoteEndpoint(net.JoinHostPort(remote.Host, strconv.Itoa(remote.Port)))
		if e != nil {
			continue
		}
		result.Remotes = append(result.Remotes, remoteDestination{id, host, port, strings.TrimSpace(remote.Token)})
	}
	return result, nil
}
func destinationConfig(c config, name string) (config, error) {
	if name == "" || name == "local" {
		return c, nil
	}
	remotes, err := readRemoteConfig(c)
	if err != nil {
		return c, err
	}
	for _, r := range remotes.Remotes {
		if r.ID == name {
			c.network = "tcp"
			c.address = net.JoinHostPort(r.Host, strconv.Itoa(r.Port))
			c.bind = c.address
			c.token = r.Token
			c.remote = true
			return c, nil
		}
	}
	return c, fmt.Errorf("unknown Browser Bridge destination %q", name)
}
func writeCLIFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".bbx-*")
	if err != nil {
		return err
	}
	temporary := f.Name()
	defer os.Remove(temporary)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}
func writeCLIJSON(path string, v interface{}) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return writeCLIFile(path, append(b, '\n'))
}
func handleRemoteCommand(ctx context.Context, c config, args []string) error {
	if len(args) == 0 {
		return errors.New("usage: bbx remote <add|remove|list|test|destinations>")
	}
	remotes, err := readRemoteConfig(c)
	if err != nil {
		return err
	}
	switch args[0] {
	case "list", "destinations":
		if len(args) != 1 {
			return errors.New("unexpected remote list argument")
		}
		if args[0] == "destinations" {
			fmt.Println("local\tlocal")
		} else if len(remotes.Remotes) == 0 {
			fmt.Println("No remote destinations configured.")
		}
		for _, r := range remotes.Remotes {
			fmt.Printf("%s\t%s\n", r.ID, net.JoinHostPort(r.Host, strconv.Itoa(r.Port)))
		}
		return nil
	case "add":
		if len(args) != 5 || (args[3] != "--token" && args[3] != "--token-file") {
			return errors.New("usage: bbx remote add <name> <host:port> (--token <token>|--token-file <path>)")
		}
		id, err := normalizeDestinationID(args[1])
		if err != nil {
			return err
		}
		host, port, err := parseRemoteEndpoint(args[2])
		if err != nil {
			return err
		}
		token := args[4]
		if args[3] == "--token-file" {
			b, err := os.ReadFile(token)
			if err != nil {
				return err
			}
			token = string(b)
		}
		token = strings.TrimSpace(token)
		if !tokenPattern.MatchString(token) {
			return errors.New("bridge auth token must be a UUID or 32-256 URL-safe characters")
		}
		remote := remoteDestination{id, host, port, token}
		found := false
		for i, r := range remotes.Remotes {
			if r.ID == id {
				remotes.Remotes[i] = remote
				found = true
				break
			}
		}
		if !found {
			remotes.Remotes = append(remotes.Remotes, remote)
		}
		if err := writeCLIJSON(filepath.Join(c.home, "remotes.json"), remotes); err != nil {
			return err
		}
		fmt.Printf("Remote destination %q saved (%s).\n", id, net.JoinHostPort(host, strconv.Itoa(port)))
		return nil
	case "remove":
		if len(args) != 2 {
			return errors.New("usage: bbx remote remove <name>")
		}
		id, err := normalizeDestinationID(args[1])
		if err != nil {
			return err
		}
		found := false
		next := []remoteDestination{}
		for _, r := range remotes.Remotes {
			if r.ID == id {
				found = true
			} else {
				next = append(next, r)
			}
		}
		remotes.Remotes = next
		if err := writeCLIJSON(filepath.Join(c.home, "remotes.json"), remotes); err != nil {
			return err
		}
		if found {
			fmt.Printf("Remote destination %q removed.\n", id)
		} else {
			fmt.Printf("Remote destination %q was not configured.\n", id)
		}
		return nil
	case "test":
		if len(args) != 2 {
			return errors.New("usage: bbx remote test <name>")
		}
		target, err := destinationConfig(c, args[1])
		if err != nil {
			return err
		}
		cl, err := connect(target, "agent")
		if err != nil {
			return err
		}
		defer cl.close()
		result, err := invokeCLI(ctx, cl, nil, "health.ping", object{})
		if err != nil {
			return err
		}
		state := "not connected"
		if result.boolean("extensionConnected") {
			state = "connected"
		}
		fmt.Printf("Remote destination %q is reachable (extension %s).\n", args[1], state)
		return nil
	}
	return errors.New("usage: bbx remote <add|remove|list|test|destinations>")
}
func windowsPipeAddress(home string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(home)))
	return `\\.\pipe\` + hostName + fmt.Sprintf("-%x", sum[:8])
}
