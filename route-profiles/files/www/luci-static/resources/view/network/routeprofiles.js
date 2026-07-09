"use strict";
"require view";
"require dom";
"require fs";
"require ui";

var UPLOAD_PATH = "/tmp/route-profiles-upload.toml";

return view.extend({
	callRouteProfiles: function(args) {
		return fs.exec("/usr/bin/route-profiles", args).then(function(res) {
			return (res.stdout || "") + (res.stderr || "");
		});
	},

	formatError: function(err) {
		var msg = err ? ((err.stderr || "") + (err.stdout || "") || err.message || String(err)) : "";
		return msg.trim() || "Command failed";
	},

	setOutput: function(text) {
		if (this.outputEl)
			dom.content(this.outputEl, [text || ""]);
	},

	setStatusBox: function(text) {
		if (this.statusEl)
			dom.content(this.statusEl, [text || ""]);
	},

	refreshStatus: function() {
		return this.callRouteProfiles(["status"]).then(function(output) {
			this.setStatusBox(output);
			return output;
		}.bind(this)).catch(function(err) {
			this.setStatusBox(this.formatError(err));
		}.bind(this));
	},

	parseList: function(output) {
		var lines = (output || "").split("\n");
		var profiles = [];
		for (var i = 0; i < lines.length; i++) {
			var line = lines[i].trim();
			// mark|id|name
			var m = line.match(/^([*-])\|([^|]+)\|(.*)$/);
			if (!m)
				continue;
			profiles.push({
				active: m[1] === "*",
				id: m[2],
				name: (m[3] || "").trim()
			});
		}
		return profiles;
	},

	refreshList: function() {
		var container = this.profilesEl;
		if (!container)
			return Promise.resolve();

		return this.callRouteProfiles(["list"]).then(function(output) {
			var profiles = this.parseList(output);
			dom.content(container, []);

			if (!profiles.length) {
				container.appendChild(E("p", {}, ["No profiles found."]));
				return;
			}

			var table = E("table", { "class": "table", "style": "width:100%" }, [
				E("tr", { "class": "tr table-titles" }, [
					E("th", { "class": "th" }, ["Active"]),
					E("th", { "class": "th" }, ["ID"]),
					E("th", { "class": "th" }, ["Name"]),
					E("th", { "class": "th" }, ["Actions"])
				])
			]);

			profiles.forEach(function(p) {
				var applyBtn = E("button", {
					"class": "cbi-button cbi-button-" + (p.active ? "action" : "apply"),
					"style": "margin:2px",
					"disabled": p.active ? "disabled" : null,
					"click": function() { this.handleApply(p.id); }.bind(this)
				}, [p.active ? "Active" : "Apply"]);

				var showBtn = E("button", {
					"class": "cbi-button cbi-button-neutral",
					"style": "margin:2px",
					"click": function() { this.handleShow(p.id); }.bind(this)
				}, ["Show"]);

				var deleteBtn = E("button", {
					"class": "cbi-button cbi-button-remove",
					"style": "margin:2px",
					"disabled": (p.id === "direct" || p.active) ? "disabled" : null,
					"click": function() { this.handleDelete(p.id); }.bind(this)
				}, ["Delete"]);

				table.appendChild(E("tr", { "class": "tr" }, [
					E("td", { "class": "td" }, [p.active ? "●" : ""]),
					E("td", { "class": "td" }, [E("code", {}, [p.id])]),
					E("td", { "class": "td" }, [p.name || "—"]),
					E("td", { "class": "td" }, [applyBtn, " ", showBtn, " ", deleteBtn])
				]));
			}.bind(this));

			container.appendChild(table);

		}.bind(this)).catch(function(err) {
			dom.content(container, [E("p", {}, [this.formatError(err)])]);
		}.bind(this));
	},

	handleApply: function(id) {
		this.setOutput("Applying profile " + id + "...");
		return this.callRouteProfiles(["apply", id]).then(function(output) {
			this.setOutput(output);
			ui.addNotification(null, E("p", ["Applied profile " + id]));
			return Promise.all([this.refreshStatus(), this.refreshList()]);
		}.bind(this)).catch(function(err) {
			var msg = this.formatError(err);
			// Apply may still have succeeded after LuCI XHR timeout (DNS/GeoIP is background now)
			if (/timed?\s*out|timeout|XHR/i.test(msg)) {
				this.setOutput(msg + "\n\nChecking whether the profile was applied...");
				ui.addNotification(null, E("p", ["Request timed out — refreshing status"]));
				return Promise.all([this.refreshStatus(), this.refreshList()]);
			}
			this.setOutput(msg);
			ui.addNotification(null, E("p", [msg]));
		}.bind(this));
	},

	handleShow: function(id) {
		return this.callRouteProfiles(["show", id]).then(function(output) {
			this.setOutput(output);
		}.bind(this)).catch(function(err) {
			this.setOutput(this.formatError(err));
		}.bind(this));
	},

	handleDelete: function(id) {
		if (!window.confirm("Delete profile \"" + id + "\"?"))
			return;
		return this.callRouteProfiles(["delete", id]).then(function(output) {
			this.setOutput(output);
			ui.addNotification(null, E("p", ["Deleted profile " + id]));
			return this.refreshList();
		}.bind(this)).catch(function(err) {
			this.setOutput(this.formatError(err));
			ui.addNotification(null, E("p", [this.formatError(err)]));
		}.bind(this));
	},

	handleUpdate: function() {
		var btn = this.updateBtn;
		if (btn) btn.setAttribute("disabled", "true");
		this.setOutput("Starting domain/GeoIP refresh in background...");
		// Async: full DNS resolve can take minutes and exceeds LuCI XHR timeout
		return this.callRouteProfiles(["update-async"]).then(function(output) {
			this.setOutput((output || "Background refresh started") +
				"\n\nLog: /tmp/route-profiles-update.log\nUse Refresh Status later to see IP counts.");
			ui.addNotification(null, E("p", ["Domain/GeoIP refresh started in background"]));
			return this.refreshStatus();
		}.bind(this)).catch(function(err) {
			this.setOutput(this.formatError(err));
			ui.addNotification(null, E("p", [this.formatError(err)]));
		}.bind(this)).finally(function() {
			if (btn) btn.removeAttribute("disabled");
		});
	},

	handleUpload: function() {
		var content = this.uploadTa ? this.uploadTa.value : "";
		var id = this.uploadIdInput ? this.uploadIdInput.value.trim() : "";
		var applyAfter = this.uploadApplyCheck;

		if (!content.trim()) {
			ui.addNotification(null, E("p", ["Paste a TOML profile first"]));
			return;
		}

		var self = this;
		this.setOutput("Importing profile...");
		return fs.write(UPLOAD_PATH, content).then(function() {
			var args = ["import", UPLOAD_PATH];
			if (id)
				args.push(id);
			return self.callRouteProfiles(args);
		}).then(function(output) {
			self.setOutput(output);
			ui.addNotification(null, E("p", ["Profile imported"]));
			if (applyAfter && applyAfter.checked) {
				var importedId = id;
				if (!importedId) {
					var m = (output || "").match(/Imported profile:\s*(\S+)/);
					importedId = m ? m[1] : null;
				}
				if (importedId)
					return self.handleApply(importedId);
			}
			return self.refreshList();
		}).catch(function(err) {
			self.setOutput(self.formatError(err));
			ui.addNotification(null, E("p", [self.formatError(err)]));
		});
	},

	handleRefreshAll: function() {
		return Promise.all([this.refreshList(), this.refreshStatus()]);
	},

	render: function() {
		this.statusEl = E("pre", {
			"class": "route-profiles-status",
			"style": "font-family:monospace; font-size:12px; white-space:pre-wrap; margin:5px 0"
		}, ["Loading..."]);

		this.profilesEl = E("div", { "class": "route-profiles-profiles" }, [
			E("p", {}, ["Loading profiles..."])
		]);

		this.outputEl = E("textarea", {
			"class": "route-profiles-output",
			"style": "width:100%; font-family:monospace; white-space:pre; height:160px",
			"readonly": true,
			"wrap": "off"
		});

		this.uploadTa = E("textarea", {
			"class": "route-upload-textarea",
			"style": "width:100%; font-family:monospace; white-space:pre; height:200px",
			"wrap": "off",
			"placeholder": "Paste a .toml profile here..."
		});

		this.uploadIdInput = E("input", {
			"class": "route-upload-id",
			"type": "text",
			"placeholder": "profile id (optional, e.g. brr)",
			"style": "min-width:16em"
		});

		this.uploadApplyCheck = E("input", {
			"class": "route-upload-apply",
			"type": "checkbox"
		});

		this.updateBtn = E("button", {
			"class": "cbi-button cbi-button-neutral route-update-btn",
			"click": function() { this.handleUpdate(); }.bind(this)
		}, ["Update Domain/GeoIP Sets"]);

		var view = E("div", { "class": "cbi-map" }, [
			E("h2", {}, ["Route Profiles"]),
			E("div", { "class": "cbi-map-descr" }, [
				"Route traffic using TOML profiles. The default profile is DIRECT (WAN). ",
				"Upload or apply another profile (for example BRR) to switch the router policy."
			]),

			E("div", { "class": "cbi-section" }, [
				E("h3", {}, ["Status"]),
				E("p", {}, [
					E("button", {
						"class": "cbi-button cbi-button-neutral",
						"click": function() { this.handleRefreshAll(); }.bind(this)
					}, ["Refresh Status"]),
					" ",
					this.updateBtn
				]),
				this.statusEl
			]),

			E("div", { "class": "cbi-section" }, [
				E("h3", {}, ["Profiles"]),
				E("div", { "class": "cbi-section-descr" }, [
					"Apply a profile to change the default route and optional selective/GeoIP rules. ",
					"Built-in direct cannot be deleted."
				]),
				this.profilesEl
			]),

			E("div", { "class": "cbi-section" }, [
				E("h3", {}, ["Upload Profile"]),
				E("div", { "class": "cbi-section-descr" }, [
					"Paste a TOML profile, optionally set an id, then import. ",
					"Check Apply after import to switch immediately."
				]),
				E("p", {}, ["Profile id: ", this.uploadIdInput]),
				this.uploadTa,
				E("p", {}, [
					this.uploadApplyCheck, " Apply after import",
					" ",
					E("button", {
						"class": "cbi-button cbi-button-action",
						"click": function() { this.handleUpload(); }.bind(this)
					}, ["Import Profile"])
				])
			]),

			E("div", { "class": "cbi-section" }, [
				E("h3", {}, ["Output"]),
				this.outputEl
			])
		]);

		// Use element refs (not document.querySelector) so load works before attach
		var self = this;
		this.refreshList().then(function() {
			return self.refreshStatus();
		});

		return view;
	}
});
