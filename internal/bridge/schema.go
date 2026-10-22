package bridge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"unicode/utf16"
)

// The exported compact-tool schemas use this JSON Schema subset. Method
// parameters still undergo the extension's shared protocol validation.
func validateSchema(raw json.RawMessage, schema object, location string) error {
	for _, keyword := range []string{"anyOf", "oneOf", "allOf"} {
		var branches []object
		if json.Unmarshal(schema[keyword], &branches) == nil && len(branches) > 0 {
			matched := 0
			for _, branch := range branches {
				if validateSchema(raw, branch, location) == nil {
					matched++
				}
			}
			if (keyword == "anyOf" && matched == 0) || (keyword == "oneOf" && matched != 1) || (keyword == "allOf" && matched != len(branches)) {
				return fmt.Errorf("%s does not match %s", location, keyword)
			}
		}
	}
	if constant, ok := schema["const"]; ok && !jsonEqual(raw, constant) {
		return fmt.Errorf("%s does not match the required value", location)
	}
	if enum, ok := schema["enum"]; ok {
		var values []json.RawMessage
		if err := json.Unmarshal(enum, &values); err != nil {
			return err
		}
		found := false
		for _, v := range values {
			found = found || jsonEqual(v, raw)
		}
		if !found {
			return fmt.Errorf("%s: value is not one of the permitted choices", location)
		}
	}
	switch schema.text("type") {
	case "object":
		obj, err := decodeObject(raw)
		if err != nil {
			return fmt.Errorf("%s must be an object", location)
		}
		var required []string
		_ = json.Unmarshal(schema["required"], &required)
		for _, key := range required {
			if _, ok := obj[key]; !ok {
				return fmt.Errorf("%s.%s is required", location, key)
			}
		}
		properties := schema.object("properties")
		for key, v := range obj {
			if names := schema.object("propertyNames"); names != nil {
				if err := validateSchema(value(key), names, location+" property name"); err != nil {
					return err
				}
			}
			if child := properties.object(key); child != nil {
				if err := validateSchema(v, child, location+"."+key); err != nil {
					return err
				}
			} else if string(schema["additionalProperties"]) == "false" {
				return fmt.Errorf("%s: unexpected property %s", location, key)
			} else if additional := schema.object("additionalProperties"); additional != nil {
				if err := validateSchema(v, additional, location+"."+key); err != nil {
					return err
				}
			}
		}
	case "string":
		var text string
		if bytes.Equal(raw, []byte("null")) || json.Unmarshal(raw, &text) != nil {
			return fmt.Errorf("%s must be a string", location)
		}
		length := int64(len(utf16.Encode([]rune(text))))
		if _, ok := schema["minLength"]; ok && length < schema.number("minLength") {
			return fmt.Errorf("%s is too short", location)
		}
		if _, ok := schema["maxLength"]; ok && length > schema.number("maxLength") {
			return fmt.Errorf("%s is too long", location)
		}
		if pattern := schema.text("pattern"); pattern != "" {
			if compiled, err := regexp.Compile(pattern); err == nil && !compiled.MatchString(text) {
				return fmt.Errorf("%s does not match the required pattern", location)
			}
		}
	case "integer", "number":
		var number float64
		if bytes.Equal(raw, []byte("null")) || json.Unmarshal(raw, &number) != nil || (schema.text("type") == "integer" && (math.Trunc(number) != number || math.Abs(number) > 9_007_199_254_740_991)) {
			return fmt.Errorf("%s must be a %s", location, schema.text("type"))
		}
		for _, key := range []string{"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"} {
			if bound, ok := schema[key]; ok {
				var limit float64
				if err := json.Unmarshal(bound, &limit); err != nil {
					return err
				}
				if (key == "minimum" && number < limit) || (key == "maximum" && number > limit) || (key == "exclusiveMinimum" && number <= limit) || (key == "exclusiveMaximum" && number >= limit) {
					return fmt.Errorf("%s is out of range", location)
				}
			}
		}
	case "boolean":
		if string(raw) != "true" && string(raw) != "false" {
			return fmt.Errorf("%s must be a boolean", location)
		}
	case "array":
		var items []json.RawMessage
		if json.Unmarshal(raw, &items) != nil || items == nil {
			return fmt.Errorf("%s must be an array", location)
		}
		if _, ok := schema["minItems"]; ok && int64(len(items)) < schema.number("minItems") {
			return fmt.Errorf("%s contains too few items", location)
		}
		if _, ok := schema["maxItems"]; ok && int64(len(items)) > schema.number("maxItems") {
			return fmt.Errorf("%s contains too many items", location)
		}
		for i, item := range items {
			if err := validateSchema(item, schema.object("items"), fmt.Sprintf("%s[%d]", location, i)); err != nil {
				return err
			}
		}
	case "null":
		if string(raw) != "null" {
			return fmt.Errorf("%s must be null", location)
		}
	}
	return nil
}

func jsonEqual(a, b json.RawMessage) bool {
	if bytes.Equal(bytes.TrimSpace(a), bytes.TrimSpace(b)) {
		return true
	}
	leftObject, leftErr := decodeObject(a)
	rightObject, rightErr := decodeObject(b)
	if leftErr == nil || rightErr == nil {
		if leftErr != nil || rightErr != nil || len(leftObject) != len(rightObject) {
			return false
		}
		for key, left := range leftObject {
			right, exists := rightObject[key]
			if !exists || !jsonEqual(left, right) {
				return false
			}
		}
		return true
	}
	var leftArray, rightArray []json.RawMessage
	if json.Unmarshal(a, &leftArray) == nil && leftArray != nil {
		if json.Unmarshal(b, &rightArray) != nil || rightArray == nil || len(leftArray) != len(rightArray) {
			return false
		}
		for i := range leftArray {
			if !jsonEqual(leftArray[i], rightArray[i]) {
				return false
			}
		}
		return true
	}
	var leftString, rightString string
	if mcpIsString(a) && mcpIsString(b) {
		_ = json.Unmarshal(a, &leftString)
		_ = json.Unmarshal(b, &rightString)
		return leftString == rightString
	}
	leftNumber, leftOK := new(big.Rat).SetString(string(a))
	rightNumber, rightOK := new(big.Rat).SetString(string(b))
	return leftOK && rightOK && leftNumber.Cmp(rightNumber) == 0
}
