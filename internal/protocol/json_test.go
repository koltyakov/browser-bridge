package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestWireFixturesRoundTrip(t *testing.T) {
	testFixtureFile(t, "../../protocol/fixtures/wire.json")
	testFixtureFile(t, "../../protocol/generated/roundtrip-fixtures.json")
}

func testFixtureFile(t *testing.T, filename string) {
	t.Helper()
	data, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Type  string
		Valid bool
		Input json.RawMessage
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		if !fixture.Valid {
			continue
		}
		t.Run(fixture.Type, func(t *testing.T) {
			convert := wireRoundTrips[fixture.Type]
			if convert == nil {
				t.Fatalf("fixture has no Go binding: %s", fixture.Type)
			}
			encoded, err := convert(fixture.Input)
			if err != nil {
				t.Fatal(err)
			}
			var original, decoded interface{}
			if err := json.Unmarshal(fixture.Input, &original); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(encoded, &decoded); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(original, decoded) {
				t.Fatalf("wire value changed:\n%s\n%s", fixture.Input, encoded)
			}
		})
	}
}

func roundTrip[T interface{}](data []byte) ([]byte, error) {
	var decoded T
	if err := json.Unmarshal(data, &decoded); err != nil {
		return nil, err
	}
	return json.Marshal(decoded)
}

func TestKnownFieldsCannotBeOverriddenByExtensionFields(t *testing.T) {
	meta := BridgeMeta{Extra: map[string]json.RawMessage{"source": json.RawMessage(`"fake"`), "new_field": json.RawMessage(`false`)}}
	encoded, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"new_field":false}` {
		t.Fatalf("known field was overridden: %s", encoded)
	}
}

func TestOptionalNullableResetOnDecode(t *testing.T) {
	var meta BridgeMeta
	if err := json.Unmarshal([]byte(`{"token_budget":0,"debugger_backed":false}`), &meta); err != nil {
		t.Fatal(err)
	}
	if !meta.TokenBudget.Set || !meta.TokenBudget.Value.Valid || meta.TokenBudget.Value.Value != 0 || !meta.DebuggerBacked.Set {
		t.Fatal("explicit zero values lost")
	}
	if err := json.Unmarshal([]byte(`{"token_budget":null}`), &meta); err != nil {
		t.Fatal(err)
	}
	if !meta.TokenBudget.Set || meta.TokenBudget.Value.Valid || meta.DebuggerBacked.Set {
		t.Fatal("null/absent distinction lost on reuse")
	}
	if err := json.Unmarshal([]byte(`{}`), &meta); err != nil {
		t.Fatal(err)
	}
	if meta.TokenBudget.Set {
		t.Fatal("omitted field retained a stale value")
	}
}

func TestGeneratedProtocolEnums(t *testing.T) {
	if !BridgeMethod("health.ping").Valid() || BridgeMethod("unknown.method").Valid() {
		t.Fatal("invalid method registry")
	}
	if !ErrorCode("ELEMENT_STALE").Valid() || ErrorCode("MADE_UP").Valid() {
		t.Fatal("invalid error registry")
	}
}

func TestArbitraryJSONNumbersAreNotConvertedThroughFloat64(t *testing.T) {
	input := []byte(`{"id":"raw","ok":true,"result":{"counter":9007199254740993,"decimal":1.0000000000000000001},"error":null,"meta":{"protocol_version":"1.14","future_counter":9007199254740993}}`)
	encoded, err := roundTrip[BridgeSuccessResponse](input)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Count(encoded, []byte("9007199254740993")) != 2 || !bytes.Contains(encoded, []byte("1.0000000000000000001")) {
		t.Fatalf("opaque JSON was rounded: %s", encoded)
	}
}

func TestExtensionFieldsAreCaseSensitive(t *testing.T) {
	var request BridgeRequest
	input := []byte(`{"id":"real","ID":"extension-field","method":"health.ping","tab_id":null,"params":{},"meta":{"protocol_version":"1.14","token_budget":null}}`)
	if err := json.Unmarshal(input, &request); err != nil {
		t.Fatal(err)
	}
	if request.ID != "real" || string(request.Extra["ID"]) != `"extension-field"` {
		t.Fatal("case-insensitive field matching changed the request ID")
	}
}

func TestNullRequiresNullableOrUnknownWireType(t *testing.T) {
	var meta BridgeMeta
	if err := json.Unmarshal([]byte(`{"source":null}`), &meta); err == nil {
		t.Fatal("non-nullable optional source accepted null")
	}
	if err := json.Unmarshal([]byte(`{"token_budget":null}`), &meta); err != nil {
		t.Fatal(err)
	}
	var request BridgeRequest
	if err := json.Unmarshal([]byte(`null`), &request); err == nil {
		t.Fatal("object binding accepted null")
	}
}
