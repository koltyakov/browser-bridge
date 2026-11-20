package bridge

import "time"

// A newer peer is evidence that the browser store may have an update. Ask only
// matching extension IDs that advertised the check protocol, not legacy peers.
func (d *daemon) checkExtensionUpdates(now time.Time) {
	if d.extensionVersions == nil {
		d.extensionVersions = map[string]string{}
	}
	newest := map[string]string{}
	for id, version := range d.extensionVersions {
		newest[id] = version
	}
	for p := range d.peers {
		if p.role == "extension" {
			id := p.identity.text("browserExtensionId")
			if browserExtensionIDPattern.MatchString(id) {
				newest[id] = updateNewestVersion(newest[id], p.identity.text("extensionVersion"))
				if _, known := d.extensionVersions[id]; known || len(d.extensionVersions) < 128 {
					d.extensionVersions[id] = newest[id]
				}
			}
		}
	}
	for p := range d.peers {
		if !p.updateReadyAt.IsZero() && now.Sub(p.updateReadyAt) >= 30*time.Second {
			d.cancelExtensionReload(p)
		}
		if p.role != "extension" || !p.identity.boolean("extensionUpdateChecks") {
			continue
		}
		target := newest[p.identity.text("browserExtensionId")]
		comparison, err := updateCompareVersions(target, p.identity.text("extensionVersion"))
		if err != nil || comparison <= 0 || !p.lastUpdateCheck.IsZero() && now.Sub(p.lastUpdateCheck) < 24*time.Hour {
			continue
		}
		p.lastUpdateCheck = now
		p.send(object{"type": value("extension.update_check"), "version": value(target)})
	}
}

func (d *daemon) requestExtensionReload(p *peer, version string) {
	if !p.identity.boolean("extensionUpdateChecks") || !p.updateReadyAt.IsZero() {
		return
	}
	if comparison, err := updateCompareVersions(version, p.identity.text("extensionVersion")); err != nil || comparison <= 0 {
		return
	}
	p.updateReadyAt, p.updateVersion = time.Now(), version
	d.grantExtensionReload(p)
}

func (d *daemon) grantExtensionReload(p *peer) {
	if p.updateReadyAt.IsZero() || p.updateApplySent || !d.peers[p] {
		return
	}
	for _, pending := range d.pending {
		if pending.target == p {
			return
		}
	}
	p.updateApplySent = true
	p.send(object{"type": value("extension.update_apply"), "version": value(p.updateVersion)})
}

func (d *daemon) cancelExtensionReload(p *peer) {
	p.updateReadyAt, p.updateVersion, p.updateApplySent = time.Time{}, "", false
}
