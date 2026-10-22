package bridge

import (
	_ "embed"
	"encoding/json"
	"sort"
)

//go:embed generated/catalog.json
var catalogBytes []byte

type protocolCatalog struct {
	Version            string                       `json:"version"`
	AllTools           []object                     `json:"allTools"`
	LegacyTools        []string                     `json:"legacyTools"`
	LoadableTools      []string                     `json:"loadableTools"`
	ToolBindings       map[string]string            `json:"toolBindings"`
	ToolGroups         map[string][]string          `json:"toolGroups"`
	LegacyInstructions string                       `json:"legacyInstructions"`
	Tools              []object                     `json:"tools"`
	Instructions       string                       `json:"instructions"`
	Methods            map[string]object            `json:"methods"`
	Runtime            object                       `json:"runtime"`
	Presets            map[string]map[string]object `json:"presets"`
	BatchSafe          []string                     `json:"batchSafe"`
}

var catalog protocolCatalog

func init() {
	if err := json.Unmarshal(catalogBytes, &catalog); err != nil {
		panic(err)
	}
	if version == "0.0.0-dev" {
		version = catalog.Version
	}
}

func describe(params object) object {
	if method := params.text("method"); method != "" {
		if entry, ok := catalog.Methods[method]; ok {
			return entry
		}
		return object{"error": value("Unknown bridge method: " + method)}
	}
	methods := []object{}
	for _, entry := range catalog.Methods {
		if group := params.text("group"); group == "" || entry.text("group") == group {
			methods = append(methods, entry)
		}
	}
	sort.Slice(methods, func(i, j int) bool { return methods[i].text("method") < methods[j].text("method") })
	return object{"methods": value(methods)}
}

func batchSafe(method string, params object) bool {
	found := false
	for _, candidate := range catalog.BatchSafe {
		if method == candidate {
			found = true
			break
		}
	}
	if !found {
		return false
	}
	if method == "page.get_console" || method == "page.get_network" {
		if clear, ok := params["clear"]; ok && string(clear) != "false" {
			return false
		}
	}
	if method == "page.get_network" && params.text("source") == "cdp" {
		if _, ok := params["capture"]; ok && params.text("capture") != "read" {
			return false
		}
	}
	return true
}
