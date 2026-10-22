// Package protocol contains generated wire types shared with the TypeScript runtime.
package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
)

func marshalJSON[T interface{}](v T) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}), nil
}

// Optional distinguishes an omitted JSON field from an explicitly supplied zero value.
type Optional[T interface{}] struct {
	Value T
	Set   bool
}

func (o Optional[T]) IsZero() bool { return !o.Set }
func (o Optional[T]) MarshalJSON() ([]byte, error) {
	if !o.Set {
		return []byte("null"), nil
	}
	return marshalJSON(o.Value)
}
func (o *Optional[T]) UnmarshalJSON(data []byte) error {
	var value T
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		if _, permitsNull := interface{}(&value).(json.Unmarshaler); !permitsNull {
			return errors.New("null is not permitted by this optional field")
		}
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	o.Value, o.Set = value, true
	return nil
}

// Nullable distinguishes JSON null from the zero value of the underlying type.
type Nullable[T interface{}] struct {
	Value T
	Valid bool
}

func (n Nullable[T]) MarshalJSON() ([]byte, error) {
	if !n.Valid {
		return []byte("null"), nil
	}
	return marshalJSON(n.Value)
}
func (n *Nullable[T]) UnmarshalJSON(data []byte) error {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		*n = Nullable[T]{}
		return nil
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	n.Value, n.Valid = value, true
	return nil
}

// Keep forward-compatible extension fields without allowing them to replace known fields.
func marshalOpen[T interface{}](v T, extra map[string]json.RawMessage, known []string) ([]byte, error) {
	data, err := marshalJSON(v)
	if err != nil || len(extra) == 0 {
		return data, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errors.New("expected JSON object")
	}
	reserved := make(map[string]bool, len(known))
	for _, key := range known {
		reserved[key] = true
	}
	for key, value := range extra {
		if !reserved[key] {
			fields[key] = value
		}
	}
	return marshalJSON(fields)
}

func unmarshalOpen[T interface{}](data []byte, destination *T, known []string) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errors.New("expected JSON object")
	}
	exact := make(map[string]json.RawMessage, len(known))
	for _, key := range known {
		if value, present := fields[key]; present {
			exact[key] = value
		}
		delete(fields, key)
	}
	// encoding/json otherwise matches struct field names case-insensitively,
	// unlike the TypeScript wire contract. Decode only exact JSON field names.
	encoded, err := json.Marshal(exact)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(encoded, destination); err != nil {
		return nil, err
	}
	if len(fields) == 0 {
		return nil, nil
	}
	return fields, nil
}
