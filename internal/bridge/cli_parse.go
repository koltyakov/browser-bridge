package bridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

const cliCallUsage = "Usage: call [--extension <connectionId>] [--browser <name>] [--profile <label>] [--tab <tabId>] [--preset quick|normal|deep] <method> [paramsJson]"

func parseCLIJSONObject(raw []byte) (object, error) {
	if len(raw) == 0 {
		return object{}, nil
	}
	if !json.Valid(raw) {
		return nil, errors.New(`Invalid JSON syntax. Expected a JSON object, e.g. '{"key":"value"}'.`)
	}
	result, err := decodeObject(raw)
	if err == nil {
		return result, nil
	}
	kind := "object"
	raw = bytes.TrimSpace(raw)
	switch raw[0] {
	case '[':
		kind = "array"
	case '"':
		kind = "string"
	case 't', 'f':
		kind = "boolean"
	case 'n':
	default:
		kind = "number"
	}
	return nil, fmt.Errorf("Expected a JSON object but got %s. Wrap your input in {}.", kind)
}
