package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type manifestProof struct {
	Path         string `json:"path"`
	HostName     string `json:"hostName"`
	Location     string `json:"location"`
	Nonce        string `json:"nonce"`
	ExtensionID  string `json:"extensionId"`
	ExtensionDir string `json:"extensionDir"`
}

type nativeReply struct {
	Location string `json:"location,omitempty"`
	Nonce    string `json:"nonce,omitempty"`
	Error    string `json:"error,omitempty"`
}

type nativeManifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins"`
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func privateExtensionKey() (string, string, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return "", "", err
	}
	data, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return "", "", err
	}
	hash := sha256.Sum256(data)
	id := make([]byte, 0, 32)
	for _, value := range hash[:16] {
		id = append(id, 'a'+(value>>4), 'a'+(value&15))
	}
	return base64.StdEncoding.EncodeToString(data), string(id), nil
}

func writeExclusive(file string, data []byte, mode os.FileMode) error {
	handle, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	_, writeErr := handle.Write(data)
	return errors.Join(writeErr, handle.Close())
}

func (r *arcRunner) writeManifest(file string, manifest nativeManifest) error {
	root, err := filepath.EvalSymlinks(r.root)
	if err != nil {
		return err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(file))
	if err != nil {
		return err
	}
	if !within(root, parent) {
		return errors.New("native manifest destination escapes the disposable run")
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err := writeExclusive(file, data, 0600); err != nil {
		return err
	}
	r.manifests = append(r.manifests, file)
	return nil
}

func (r *arcRunner) createProbeManifest(ctx context.Context) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key, id, err := privateExtensionKey()
	if err != nil {
		return nil, err
	}
	extension := filepath.Join(r.root, "lookup-extension")
	if err := os.Mkdir(extension, 0700); err != nil {
		return nil, err
	}
	manifest := struct {
		ManifestVersion int               `json:"manifest_version"`
		Name            string            `json:"name"`
		Version         string            `json:"version"`
		Key             string            `json:"key"`
		Permissions     []string          `json:"permissions"`
		Background      map[string]string `json:"background"`
	}{3, "Disposable Arc native lookup probe", "1.0", key, []string{"nativeMessaging"}, map[string]string{"service_worker": "worker.js"}}
	data, err := json.Marshal(manifest)
	if err != nil {
		return nil, err
	}
	if err := writeExclusive(filepath.Join(extension, "manifest.json"), data, 0600); err != nil {
		return nil, err
	}
	if err := writeExclusive(filepath.Join(extension, "worker.js"), []byte("// @ts-check\nchrome.runtime.onInstalled.addListener(() => {});\n"), 0600); err != nil {
		return nil, err
	}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	location := filepath.Join(r.isolation.Profile, "NativeMessagingHosts")
	if err := os.MkdirAll(location, 0700); err != nil {
		return nil, err
	}
	name := "com.browserbridge.arc_probe_" + hex.EncodeToString(nonce)
	r.probe = manifestProof{filepath.Join(location, name+".json"), name, location, hex.EncodeToString(nonce), id, extension}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return nil, err
	}
	launcher := filepath.Join(r.root, "lookup-host.sh")
	body := "#!/bin/sh\nexec " + shellQuote(executable) + " --probe-host " + shellQuote(location) + " " + shellQuote(r.probe.Nonce) + " arc-lookup\n"
	if err := writeExclusive(launcher, []byte(body), 0700); err != nil {
		return nil, err
	}
	if err := r.writeManifest(r.probe.Path, nativeManifest{name, "Disposable Arc lookup probe", launcher, "stdio", []string{"chrome-extension://" + id + "/"}}); err != nil {
		return nil, err
	}
	return json.Marshal(r.probe)
}

func (r *arcRunner) loadExtension(ctx context.Context, directory, expectedID string) error {
	params, _ := json.Marshal(map[string]string{"path": directory})
	data, err := r.client.command(ctx, "Extensions.loadUnpacked", params, "")
	if err != nil {
		return err
	}
	var response struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return err
	}
	if response.ID != expectedID {
		return errors.New("loaded extension ID does not match the private test extension")
	}
	return nil
}

func validateNativeReply(data []byte, proof manifestProof) error {
	var response nativeReply
	if err := json.Unmarshal(data, &response); err != nil {
		return err
	}
	if response.Error != "" {
		return fmt.Errorf("native host did not respond: %s", response.Error)
	}
	if response.Location != proof.Location || response.Nonce != proof.Nonce || response.Nonce == "" {
		return errors.New("native-host response does not match this run's location and nonce")
	}
	return nil
}

func (r *arcRunner) lookupNativeHost(ctx context.Context) (json.RawMessage, error) {
	if err := r.loadExtension(ctx, r.probe.ExtensionDir, r.probe.ExtensionID); err != nil {
		return nil, err
	}
	var workerID string
	err := waitProbe(ctx, "lookup extension worker did not initialize", func() (bool, error) {
		data, err := r.client.command(ctx, "Target.getTargets", nil, "")
		if err != nil {
			return false, err
		}
		var response struct {
			Targets []struct {
				ID   string `json:"targetId"`
				Type string `json:"type"`
				URL  string `json:"url"`
			} `json:"targetInfos"`
		}
		if err := json.Unmarshal(data, &response); err != nil {
			return false, err
		}
		for _, target := range response.Targets {
			if target.Type == "service_worker" && target.URL == "chrome-extension://"+r.probe.ExtensionID+"/worker.js" {
				workerID = target.ID
				return true, nil
			}
		}
		return false, nil
	})
	if err != nil {
		return nil, err
	}
	params, _ := json.Marshal(struct {
		Target  string `json:"targetId"`
		Flatten bool   `json:"flatten"`
	}{workerID, true})
	data, err := r.client.command(ctx, "Target.attachToTarget", params, "")
	if err != nil {
		return nil, err
	}
	var attached struct {
		Session string `json:"sessionId"`
	}
	if err := json.Unmarshal(data, &attached); err != nil {
		return nil, err
	}
	name, _ := json.Marshal(r.probe.HostName)
	expression := `new Promise(resolve => {
 const port = chrome.runtime.connectNative(` + string(name) + `);
 const timer = setTimeout(() => { resolve({error:'native probe timeout'}); port.disconnect(); }, 3000);
 port.onMessage.addListener(message => { clearTimeout(timer); resolve(message); port.disconnect(); });
 port.onDisconnect.addListener(() => { clearTimeout(timer); resolve({error:chrome.runtime.lastError?.message || 'disconnected'}); });
})`
	result, err := r.client.evaluate(ctx, expression, attached.Session)
	if err != nil {
		return nil, err
	}
	return result, validateNativeReply(result, r.probe)
}

func copyExtension(source, destination string) error {
	return filepath.WalkDir(source, func(file string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("built extension contains a symlink")
		}
		relative, err := filepath.Rel(source, file)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		if !entry.Type().IsRegular() {
			return errors.New("built extension contains a special file")
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		return writeExclusive(target, data, 0600)
	})
}

func validateBridgeHealth(data []byte) error {
	var health struct {
		Daemon             string `json:"daemon"`
		ExtensionConnected bool   `json:"extensionConnected"`
	}
	if err := json.Unmarshal(data, &health); err != nil {
		return err
	}
	if health.Daemon != "ok" || !health.ExtensionConnected {
		return errors.New("isolated daemon has not reported an extension connection")
	}
	return nil
}

func (r *arcRunner) connectBridge(ctx context.Context) (json.RawMessage, error) {
	key, id, err := privateExtensionKey()
	if err != nil {
		return nil, err
	}
	extension := filepath.Join(r.root, "bridge-extension")
	if err := copyExtension(r.extension, extension); err != nil {
		return nil, err
	}
	manifestFile := filepath.Join(extension, "manifest.json")
	data, err := os.ReadFile(manifestFile)
	if err != nil {
		return nil, err
	}
	var manifest map[string]json.RawMessage
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, err
	}
	manifest["key"], _ = json.Marshal(key)
	data, err = json.Marshal(manifest)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(manifestFile, data, 0600); err != nil {
		return nil, err
	}
	launcher := filepath.Join(r.root, "bridge-host.sh")
	body := "#!/bin/sh\nexport BROWSER_BRIDGE_HOME=" + shellQuote(r.bridgeHome) + "\nexec " + shellQuote(r.executable) + " --native-host \"$@\"\n"
	if err := writeExclusive(launcher, []byte(body), 0700); err != nil {
		return nil, err
	}
	host := nativeManifest{"com.browserbridge.browser_bridge", "Isolated Arc BBX verification", launcher, "stdio", []string{"chrome-extension://" + id + "/"}}
	if err := r.writeManifest(filepath.Join(r.probe.Location, host.Name+".json"), host); err != nil {
		return nil, err
	}
	log, err := os.OpenFile(filepath.Join(r.root, "daemon.log"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	r.logs = append(r.logs, log)
	daemon := exec.Command(r.executable, "--bridge-daemon")
	daemon.Env, daemon.Stdout, daemon.Stderr = r.env, log, log
	ownProcess(daemon)
	if err := daemon.Start(); err != nil {
		return nil, err
	}
	r.children = append(r.children, daemon)
	// Do not load the real extension until the owned daemon is responding.
	if err := waitProbe(ctx, "isolated daemon did not start", func() (bool, error) {
		data, err := r.health(ctx)
		return json.Valid(data) && err == nil, nil
	}); err != nil {
		return nil, err
	}
	if err := r.loadExtension(ctx, extension, id); err != nil {
		return nil, err
	}
	var last json.RawMessage
	err = waitProbe(ctx, "bridge connection not observed", func() (bool, error) {
		data, err := r.health(ctx)
		if err != nil {
			return false, nil
		}
		if json.Valid(data) {
			last = data
		}
		return validateBridgeHealth(data) == nil, nil
	})
	return last, err
}

func (r *arcRunner) health(ctx context.Context) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, r.executable, "call", "health.ping", "{}")
	command.Env = r.env
	data, err := command.Output()
	return json.RawMessage(data), err
}
