package bridge

import (
	"encoding/json"
	"fmt"
)

type cliSummaryDone func(text string, evidence json.RawMessage, withWarning bool) object

// cliIndexedDbStorageSummary lists database and store metadata per frame.
func cliIndexedDbStorageSummary(r object, frames []json.RawMessage, done cliSummaryDone) object {
	out := []object{}
	databases := 0
	incomplete := false
	for _, raw := range frames {
		frame := cliRecord(raw)
		dbs := []object{}
		entries, _ := cliArray(frame["databases"])
		for _, dbRaw := range entries {
			db := cliRecord(dbRaw)
			stores := []object{}
			storeEntries, _ := cliArray(db["stores"])
			for _, storeRaw := range storeEntries {
				store := cliRecord(storeRaw)
				item := cliPick(store, "name", "keyPath", "autoIncrement", "count")
				names := []json.RawMessage{}
				indexes, _ := cliArray(store["indexes"])
				for _, indexRaw := range indexes {
					names = append(names, cliRecord(indexRaw)["name"])
				}
				item["indexes"] = value(names)
				stores = append(stores, item)
			}
			item := cliPick(db, "name", "version", "storeCount", "error")
			item["stores"] = value(stores)
			dbs = append(dbs, item)
		}
		databases += len(dbs)
		reasons, _ := cliArray(frame["incomplete"])
		incomplete = incomplete || len(reasons) > 0
		item := cliPick(frame, "frameId", "origin", "available", "total", "incomplete")
		item["databases"] = value(dbs)
		out = append(out, item)
	}
	evidence := object{"frames": value(out)}
	if missing, ok := cliArray(r["incompleteFrames"]); ok && len(missing) > 0 {
		evidence["incompleteFrames"] = r["incompleteFrames"]
		incomplete = true
	}
	text := fmt.Sprintf("IndexedDB: %d database(s) across %d frame(s). Records are never listed.", databases, len(out))
	if incomplete {
		text += " Incomplete; see incomplete reasons."
	}
	return done(text, value(evidence), true)
}
