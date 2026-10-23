package bridge

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Generated from skills/browser-bridge by the native build script. Keeping the
// bundle inside the executable makes `go install` installations self-contained.
//
//go:embed assets/skills.bundle
var installSkillArchive []byte

const installSkillSentinel = ".browser-bridge-managed"
const installCopilotNote = "\n\n## GitHub Copilot Note\n\nWhen this skill is installed for GitHub Copilot, do not keep retrying `bbx` inside a sandboxed shell if Browser Bridge MCP is already configured for Copilot.\nIf Browser Bridge MCP is installed, use the MCP tools directly instead of shelling out to `bbx`.\nIf `bbx` fails with a bridge socket permission error such as `EPERM`, stop retrying in the sandbox and ask the user to run the command locally or use MCP.\n"

type installSkillMetadata struct {
	Skill     string            `json:"skill"`
	ManagedBy string            `json:"managedBy"`
	Version   string            `json:"version"`
	Targets   []string          `json:"targets,omitempty"`
	Files     map[string]string `json:"files,omitempty"`
}

func installSkillBase(target string, scope installScope) string {
	if !installContains(installAgentNames, target) {
		return ""
	}
	base := scope.project
	paths := map[string]string{"codex": ".codex/skills", "claude": ".claude/skills", "opencode": ".opencode/skills", "copilot": ".github/skills", "cursor": ".cursor/skills", "windsurf": ".windsurf/skills", "antigravity": ".agents/skills", "gemini": ".gemini/skills", "cline": ".cline/skills", "zed": ".agents/skills", "amp": ".agents/skills", "droid": ".factory/skills", "agents": ".agents/skills"}
	if scope.global {
		base = scope.home
		if target == "gemini" {
			base = installGeminiHome(scope)
		}
		if target == "cline" {
			return filepath.Join(installClineHome(scope), "skills")
		}
		paths["copilot"] = ".copilot/skills"
		paths["antigravity"] = ".gemini/antigravity/skills"
		paths["windsurf"] = ".codeium/windsurf/skills"
		paths["amp"] = ".config/amp/skills"
	}
	return filepath.Join(base, filepath.FromSlash(paths[target]))
}

func installSkillFiles(target string) (map[string][]byte, error) {
	archive, err := zip.NewReader(bytes.NewReader(installSkillArchive), int64(len(installSkillArchive)))
	if err != nil {
		return nil, err
	}
	files := map[string][]byte{}
	for _, entry := range archive.File {
		if entry.FileInfo().IsDir() {
			continue
		}
		if !fs.ValidPath(entry.Name) || strings.Contains(entry.Name, "\\") {
			return nil, fmt.Errorf("invalid embedded skill path %q", entry.Name)
		}
		reader, err := entry.Open()
		if err != nil {
			return nil, err
		}
		data, readErr := io.ReadAll(io.LimitReader(reader, 8*1024*1024))
		closeErr := reader.Close()
		if readErr != nil {
			return nil, readErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if target == "copilot" && entry.Name == "SKILL.md" && !bytes.Contains(data, []byte("## GitHub Copilot Note")) {
			data = []byte(strings.TrimRight(string(data), "\r\n") + installCopilotNote)
		}
		files[entry.Name] = data
	}
	if len(files["SKILL.md"]) == 0 {
		return nil, fmt.Errorf("embedded skill bundle is missing SKILL.md")
	}
	return files, nil
}

func installSkillHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// Match the npm installer's rollback: a later target failure removes newly
// created installs, while pre-existing managed bundles remain installed.
func installAgentSkills(targets []string, scope installScope) ([]string, error) {
	paths := []string{}
	created := []string{}
	seen := map[string]bool{}
	for _, target := range targets {
		if !installContains(installAgentNames, target) {
			return nil, fmt.Errorf("unsupported skill target %q", target)
		}
	}
	rollback := func(cause error) ([]string, error) {
		for _, previous := range created {
			path := filepath.Join(installSkillBase(previous, scope), "browser-bridge")
			resolved, resolveErr := installCanonicalDestination(path)
			if resolveErr != nil {
				cause = errors.Join(cause, resolveErr)
				continue
			}
			metadata, managed, readErr := installReadSkillMetadata(resolved)
			if readErr != nil {
				cause = errors.Join(cause, readErr)
			} else if managed {
				if _, err := installRemoveSkill(previous, path, resolved, metadata); err != nil {
					cause = errors.Join(cause, fmt.Errorf("rollback %s: %w", previous, err))
				}
			}
		}
		return nil, cause
	}
	for _, target := range targets {
		path := filepath.Join(installSkillBase(target, scope), "browser-bridge")
		resolved, err := installCanonicalDestination(path)
		if err != nil {
			return rollback(err)
		}
		if seen[resolved] {
			metadata, managed, readErr := installReadSkillMetadata(resolved)
			if readErr != nil {
				return rollback(readErr)
			}
			if managed && !installContains(metadata.Targets, target) {
				metadata.Targets = append(metadata.Targets, target)
				if err := installWriteSkillMetadata(resolved, metadata); err != nil {
					return rollback(err)
				}
			}
			continue
		}
		seen[resolved] = true
		existed := installExists(path)
		installed, err := installAgentSkill(target, scope, false)
		if err != nil {
			return rollback(err)
		}
		if !existed {
			created = append(created, target)
		}
		paths = append(paths, installed...)
	}
	return paths, nil
}

// Copy custom files and links into the staged upgrade. Directory traversal never
// follows nested symlinks, so an upgrade cannot modify unrelated dotfiles.
func installCopySkillTree(source, dest string) error {
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dest, relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		if entry.Type()&os.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("cannot copy special skill file %s", path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, info.Mode().Perm())
	})
}

func installReadSkillMetadata(path string) (installSkillMetadata, bool, error) {
	data, err := os.ReadFile(filepath.Join(path, installSkillSentinel))
	if errors.Is(err, os.ErrNotExist) {
		return installSkillMetadata{}, false, nil
	}
	if err != nil {
		return installSkillMetadata{}, false, err
	}
	metadata := installSkillMetadata{}
	// Old sentinels were empty or plain text, and still mark a managed bundle.
	_ = json.Unmarshal(data, &metadata)
	return metadata, true, nil
}

func installAgentSkill(target string, scope installScope, remove bool) ([]string, error) {
	if !installContains(installAgentNames, target) {
		return nil, fmt.Errorf("unsupported skill target %q", target)
	}
	path := filepath.Join(installSkillBase(target, scope), "browser-bridge")
	resolved, err := installResolveFile(path)
	if err != nil {
		return nil, err
	}
	_, statErr := os.Stat(resolved)
	exists := statErr == nil
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return nil, statErr
	}
	metadata, managed, err := installReadSkillMetadata(resolved)
	if err != nil {
		return nil, err
	}
	if remove {
		if !exists || !managed {
			return []string{}, nil
		}
		owners := installSkillOwners(metadata, target, scope)
		if !installContains(owners, target) {
			return []string{}, nil
		}
		if len(owners) > 1 {
			metadata.Targets = nil
			for _, owner := range owners {
				if owner != target {
					metadata.Targets = append(metadata.Targets, owner)
				}
			}
			return []string{path}, installWriteSkillMetadata(resolved, metadata)
		}
		return installRemoveSkill(target, path, resolved, metadata)
	}
	if exists && !managed {
		return nil, fmt.Errorf("refusing to overwrite unmanaged skill directory: %s", path)
	}
	files, err := installSkillFiles(target)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(resolved), 0755); err != nil {
		return nil, err
	}
	stage, err := os.MkdirTemp(filepath.Dir(resolved), ".browser-bridge-skill-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(stage)
	if exists {
		if err := installCopySkillTree(resolved, stage); err != nil {
			return nil, err
		}
	}
	updated := installSkillMetadata{Skill: "browser-bridge", ManagedBy: "@browserbridge/bbx", Version: version, Files: map[string]string{}}
	if exists && managed {
		updated.Targets = installSkillOwners(metadata, target, scope)
	}
	if !installContains(updated.Targets, target) {
		updated.Targets = append(updated.Targets, target)
	}
	for name, data := range files {
		dest := filepath.Join(stage, filepath.FromSlash(name))
		// A link at any level is user-owned; do not dereference it while writing.
		for current := dest; current != stage; current = filepath.Dir(current) {
			if info, err := os.Lstat(current); err == nil && info.Mode()&os.ModeSymlink != 0 {
				return nil, fmt.Errorf("refusing to overwrite skill symlink: %s", filepath.Join(path, filepath.FromSlash(name)))
			}
		}
		if previous, ok := metadata.Files[name]; ok {
			if old, err := os.ReadFile(dest); err == nil && installSkillHash(old) != previous && !bytes.Equal(old, data) {
				return nil, fmt.Errorf("skill file has local edits: %s", filepath.Join(path, filepath.FromSlash(name)))
			}
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(dest, data, 0644); err != nil {
			return nil, err
		}
		updated.Files[name] = installSkillHash(data)
	}
	// Delete obsolete shipped files only when their recorded content is intact.
	for name, hash := range metadata.Files {
		if _, present := files[name]; present || !fs.ValidPath(name) || strings.Contains(name, "\\") {
			continue
		}
		dest := filepath.Join(stage, filepath.FromSlash(name))
		if data, err := os.ReadFile(dest); err == nil && installSkillHash(data) == hash {
			_ = os.Remove(dest)
		}
	}
	sentinel, err := json.MarshalIndent(updated, "", "  ")
	if err != nil {
		return nil, err
	}
	// Remove a copied sentinel link, rather than writing through it.
	if err := os.Remove(filepath.Join(stage, installSkillSentinel)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(stage, installSkillSentinel), append(sentinel, '\n'), 0644); err != nil {
		return nil, err
	}
	if err := os.Chmod(stage, 0755); err != nil {
		return nil, err
	}
	backup := resolved + ".backup-" + uniqueID()
	if exists {
		if err := os.Rename(resolved, backup); err != nil {
			return nil, err
		}
	}
	if err := os.Rename(stage, resolved); err != nil {
		if exists {
			if restoreErr := os.Rename(backup, resolved); restoreErr != nil {
				return nil, fmt.Errorf("%w; restore %s: %v", err, backup, restoreErr)
			}
		}
		return nil, err
	}
	if exists {
		if err := os.RemoveAll(backup); err != nil {
			return []string{path}, fmt.Errorf("installed skill; cannot remove backup %s: %w", backup, err)
		}
	}
	return []string{path}, nil
}

// Shared .agents skills can serve several explicitly selected clients. Preserve
// the other clients' ownership when uninstalling one integration. Legacy shared
// bundles are conservatively attributed to the generic agents target.
func installSkillOwners(metadata installSkillMetadata, target string, scope installScope) []string {
	if len(metadata.Targets) > 0 {
		return append([]string{}, metadata.Targets...)
	}
	base := installSkillBase(target, scope)
	generic := installSkillBase("agents", scope)
	if base == generic {
		return []string{"agents"}
	}
	resolved, err := installCanonicalDestination(base)
	shared, sharedErr := installCanonicalDestination(generic)
	if err == nil && sharedErr == nil && resolved == shared {
		return []string{"agents"}
	}
	return []string{target}
}

func installWriteSkillMetadata(path string, metadata installSkillMetadata) error {
	sentinel := filepath.Join(path, installSkillSentinel)
	if info, err := os.Lstat(sentinel); err != nil {
		return err
	} else if !info.Mode().IsRegular() {
		return fmt.Errorf("refusing to overwrite non-file skill metadata: %s", sentinel)
	}
	data, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return err
	}
	return installAtomicWrite(sentinel, append(data, '\n'), 0644)
}

func installRemoveSkill(target, path, resolved string, metadata installSkillMetadata) ([]string, error) {
	info, statErr := os.Lstat(path)
	preserveTopLink := statErr == nil && info.Mode()&os.ModeSymlink != 0
	files := metadata.Files
	if files == nil {
		// Legacy sentinels have no inventory. Remove only recognizable shipped
		// contents, leaving custom or locally edited files in place.
		bundle, err := installSkillFiles(target)
		if err != nil {
			return nil, err
		}
		files = map[string]string{}
		for name, data := range bundle {
			files[name] = installSkillHash(data)
		}
	}
	for name, hash := range files {
		if !fs.ValidPath(name) || strings.Contains(name, "\\") {
			continue
		}
		file := filepath.Join(resolved, filepath.FromSlash(name))
		linked := false
		for current := file; current != resolved; current = filepath.Dir(current) {
			if info, err := os.Lstat(current); err == nil && info.Mode()&os.ModeSymlink != 0 {
				linked = true
				break
			}
		}
		if linked {
			continue
		}
		data, err := os.ReadFile(file)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if installSkillHash(data) != hash {
			continue
		}
		if err := os.Remove(file); err != nil {
			return nil, err
		}
	}
	if err := os.Remove(filepath.Join(resolved, installSkillSentinel)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	dirs := []string{}
	if err := filepath.WalkDir(resolved, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			dirs = append(dirs, path)
		}
		return nil
	}); err != nil {
		return nil, err
	}
	sort.Slice(dirs, func(i, j int) bool { return len(dirs[i]) > len(dirs[j]) })
	for _, dir := range dirs {
		// Preserve a user's top-level link, including its empty target.
		if dir == resolved && preserveTopLink {
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil, err
		}
		if len(entries) == 0 {
			if err := os.Remove(dir); err != nil {
				return nil, err
			}
		}
	}
	return []string{path}, nil
}
