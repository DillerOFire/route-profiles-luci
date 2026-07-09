"use strict";
"require view";
"require dom";
"require fs";
"require ui";

var UPLOAD_PATH = "/tmp/route-profiles-upload.toml";
var MAX_SELECTIVE = 8;

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

	/* ------------------------------------------------------------------ */
	/* TOML helpers (profile subset used by route-profiles)               */
	/* ------------------------------------------------------------------ */

	unquoteToml: function(raw) {
		var s = String(raw || "").trim();
		if ((s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') ||
		    (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'")) {
			s = s.slice(1, -1);
			s = s.replace(/\\n/g, "\n").replace(/\\t/g, "\t")
				.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		}
		return s;
	},

	escapeToml: function(s) {
		return String(s == null ? "" : s)
			.replace(/\\/g, "\\\\")
			.replace(/"/g, '\\"');
	},

	splitLines: function(text) {
		return String(text || "").split(/\r?\n/).map(function(l) {
			return l.trim();
		}).filter(function(l) {
			return l.length > 0 && l.charAt(0) !== "#";
		});
	},

	emptyProfileModel: function() {
		return {
			name: "",
			description: "",
			route: { type: "interface", device: "", gateway: "" },
			selective: [],
			geoip: {
				enabled: false,
				source_url: "https://www.ipdeny.com/ipblocks/data/countries/ru.zone",
				domains: [],
				lists: []
			}
		};
	},

	/* Line-oriented parser for the profile schema (not full TOML). */
	parseProfileToml: function(text) {
		var model = this.emptyProfileModel();
		var lines = String(text || "").split(/\r?\n/);
		var section = "";
		var currentSel = null;
		var arrayKey = null;
		var arrayBuf = null;
		var arrayTarget = null;
		var i, line, m, key, val, lbl;

		var flushArray = function() {
			if (!arrayKey || !arrayTarget)
				return;
			arrayTarget[arrayKey] = arrayBuf || [];
			arrayKey = null;
			arrayBuf = null;
			arrayTarget = null;
		};

		var startSelective = function(label) {
			flushArray();
			currentSel = {
				label: label || "default",
				enabled: false,
				device: "",
				domains: [],
				lists: []
			};
			model.selective.push(currentSel);
			section = "selective";
		};

		for (i = 0; i < lines.length; i++) {
			line = lines[i].replace(/\s+$/, "");
			var trimmed = line.trim();

			if (!trimmed || trimmed.charAt(0) === "#")
				continue;

			// Multi-line string array continuation
			if (arrayKey) {
				if (trimmed === "]") {
					flushArray();
					continue;
				}
				m = trimmed.match(/^"((?:\\.|[^"\\])*)"\s*,?\s*$/) ||
					trimmed.match(/^'([^']*)'\s*,?\s*$/) ||
					trimmed.match(/^([^,#\]]+?)\s*,?\s*$/);
				if (m)
					arrayBuf.push(this.unquoteToml(m[1] != null ? m[1] : m[0]));
				continue;
			}

			if (trimmed === "[[selective]]") {
				startSelective("sel" + (model.selective.length + 1));
				continue;
			}

			m = trimmed.match(/^\[([^\]]+)\]$/);
			if (m) {
				flushArray();
				currentSel = null;
				var sec = m[1].trim();
				if (sec === "route") {
					section = "route";
				} else if (sec === "geoip") {
					section = "geoip";
				} else if (sec === "selective") {
					startSelective("default");
				} else if (sec.indexOf("selective.") === 0) {
					lbl = sec.slice("selective.".length);
					startSelective(lbl);
				} else {
					section = sec;
				}
				continue;
			}

			// key = [ ... ] inline or start
			m = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*\[\s*(.*)\]\s*$/);
			if (m) {
				key = m[1];
				var inner = m[2].trim();
				var items = [];
				if (inner) {
					// crude split on commas outside quotes
					var parts = inner.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^,]+/g) || [];
					for (var p = 0; p < parts.length; p++) {
						var it = parts[p].trim();
						if (!it) continue;
						items.push(this.unquoteToml(it.replace(/,\s*$/, "")));
					}
				}
				if (section === "selective" && currentSel && (key === "domains" || key === "lists"))
					currentSel[key] = items;
				else if (section === "geoip" && (key === "domains" || key === "lists"))
					model.geoip[key] = items;
				continue;
			}

			m = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*\[\s*$/);
			if (m) {
				key = m[1];
				arrayKey = key;
				arrayBuf = [];
				if (section === "selective" && currentSel && (key === "domains" || key === "lists"))
					arrayTarget = currentSel;
				else if (section === "geoip" && (key === "domains" || key === "lists"))
					arrayTarget = model.geoip;
				else
					arrayTarget = null;
				continue;
			}

			m = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
			if (!m)
				continue;

			key = m[1];
			val = m[2].trim();
			// strip trailing comment for non-strings
			if (val.charAt(0) !== '"' && val.charAt(0) !== "'")
				val = val.replace(/\s+#.*$/, "").trim();

			if (section === "" || section === "root") {
				if (key === "name")
					model.name = this.unquoteToml(val);
				else if (key === "description")
					model.description = this.unquoteToml(val);
			} else if (section === "route") {
				if (key === "type")
					model.route.type = this.unquoteToml(val);
				else if (key === "device")
					model.route.device = this.unquoteToml(val);
				else if (key === "gateway")
					model.route.gateway = this.unquoteToml(val);
			} else if (section === "selective" && currentSel) {
				if (key === "enabled")
					currentSel.enabled = /^(true|1|yes|on)$/i.test(this.unquoteToml(val));
				else if (key === "device")
					currentSel.device = this.unquoteToml(val);
			} else if (section === "geoip") {
				if (key === "enabled")
					model.geoip.enabled = /^(true|1|yes|on)$/i.test(this.unquoteToml(val));
				else if (key === "source_url")
					model.geoip.source_url = this.unquoteToml(val);
			}
		}
		flushArray();

		if (!model.selective.length) {
			model.selective.push({
				label: "default",
				enabled: false,
				device: "",
				domains: [],
				lists: []
			});
		}

		return model;
	},

	serializeProfileToml: function(model) {
		var self = this;
		var out = [];
		var writeArray = function(key, items) {
			out.push(key + " = [");
			(items || []).forEach(function(item) {
				if (!item) return;
				out.push('\t"' + self.escapeToml(item) + '",');
			});
			out.push("]");
		};

		out.push('name = "' + self.escapeToml(model.name || "") + '"');
		out.push('description = "' + self.escapeToml(model.description || "") + '"');
		out.push("");
		out.push("[route]");
		out.push('type = "' + self.escapeToml(model.route.type || "direct") + '"');
		if (model.route.device)
			out.push('device = "' + self.escapeToml(model.route.device) + '"');
		if (model.route.gateway)
			out.push('gateway = "' + self.escapeToml(model.route.gateway) + '"');
		out.push("");

		var blocks = model.selective || [];
		// Single unnamed block → [selective]; multiple / named → [selective.label]
		var useNamed = blocks.length > 1 || (blocks[0] && blocks[0].label && blocks[0].label !== "default");
		blocks.forEach(function(block, idx) {
			var label = (block.label || ("sel" + (idx + 1))).trim();
			if (!useNamed && idx === 0)
				out.push("[selective]");
			else {
				label = label.replace(/[^A-Za-z0-9._-]/g, "-") || ("sel" + (idx + 1));
				out.push("[selective." + label + "]");
			}
			out.push("enabled = " + (block.enabled ? "true" : "false"));
			if (block.device)
				out.push('device = "' + self.escapeToml(block.device) + '"');
			writeArray("domains", block.domains);
			writeArray("lists", block.lists);
			out.push("");
		});

		out.push("[geoip]");
		out.push("enabled = " + (model.geoip.enabled ? "true" : "false"));
		if (model.geoip.source_url)
			out.push('source_url = "' + self.escapeToml(model.geoip.source_url) + '"');
		writeArray("domains", model.geoip.domains);
		writeArray("lists", model.geoip.lists);
		out.push("");

		return out.join("\n");
	},

	/* ------------------------------------------------------------------ */
	/* List actions                                                       */
	/* ------------------------------------------------------------------ */

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
				var editBtn = E("button", {
					"class": "cbi-button cbi-button-positive important",
					"style": "margin:2px",
					"title": "Edit profile",
					"click": function() { this.handleEdit(p.id); }.bind(this)
				}, ["Edit"]);

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
					E("td", { "class": "td" }, [editBtn, " ", applyBtn, " ", showBtn, " ", deleteBtn])
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

	/* ------------------------------------------------------------------ */
	/* Edit dialog                                                        */
	/* ------------------------------------------------------------------ */

	fieldRow: function(label, node, hint) {
		return E("div", {
			"class": "cbi-value",
			"style": "display:flex; flex-wrap:wrap; gap:8px; align-items:flex-start; margin:8px 0"
		}, [
			E("label", {
				"class": "cbi-value-title",
				"style": "min-width:9em; font-weight:600; padding-top:6px"
			}, [label]),
			E("div", {
				"class": "cbi-value-field",
				"style": "flex:1; min-width:14em"
			}, hint ? [node, E("div", {
				"class": "cbi-value-description",
				"style": "opacity:0.75; font-size:12px; margin-top:4px"
			}, [hint])] : [node])
		]);
	},

	textInput: function(value, attrs) {
		var a = Object.assign({
			"type": "text",
			"class": "cbi-input-text",
			"style": "width:100%; box-sizing:border-box",
			"value": value || ""
		}, attrs || {});
		return E("input", a);
	},

	textArea: function(value, attrs) {
		var a = Object.assign({
			"class": "cbi-input-textarea",
			"style": "width:100%; box-sizing:border-box; font-family:monospace; min-height:6em; white-space:pre",
			"wrap": "off"
		}, attrs || {});
		var el = E("textarea", a);
		el.value = value || "";
		return el;
	},

	selectInput: function(value, options, attrs) {
		var a = Object.assign({
			"class": "cbi-input-select",
			"style": "min-width:12em"
		}, attrs || {});
		var sel = E("select", a, options.map(function(opt) {
			var o = E("option", { "value": opt.value }, [opt.label]);
			if (String(opt.value) === String(value))
				o.selected = true;
			return o;
		}));
		return sel;
	},

	checkboxInput: function(checked, label) {
		var box = E("input", {
			"type": "checkbox",
			"style": "margin-right:6px"
		});
		box.checked = !!checked;
		return E("label", { "style": "display:inline-flex; align-items:center; gap:4px; user-select:none" }, [
			box, label || ""
		]);
	},

	sectionBox: function(title, children, extra) {
		return E("div", {
			"class": "cbi-section",
			"style": "border:1px solid var(--border-color-soft,#ddd); border-radius:6px; padding:12px 14px; margin:12px 0; background:var(--background-color-high,#fafafa)"
		}, [
			E("h4", { "style": "margin:0 0 8px 0" }, [title])
		].concat(children || []).concat(extra || []));
	},

	buildSelectiveEditor: function(block, index, onRemove) {
		var self = this;
		var labelIn = this.textInput(block.label || ("sel" + (index + 1)), {
			"placeholder": "block id (e.g. ai, warp)"
		});
		var enabledWrap = this.checkboxInput(block.enabled, "Enabled");
		var deviceIn = this.textInput(block.device || "", {
			"placeholder": "device (optional → route.device)"
		});
		var domainsTa = this.textArea((block.domains || []).join("\n"), {
			"placeholder": "one domain per line",
			"style": "width:100%; box-sizing:border-box; font-family:monospace; min-height:8em; white-space:pre"
		});
		var listsTa = this.textArea((block.lists || []).join("\n"), {
			"placeholder": "one list URL/path per line (optional prefix: geosite:, srs:, …)",
			"style": "width:100%; box-sizing:border-box; font-family:monospace; min-height:5em; white-space:pre"
		});

		var header = E("div", {
			"style": "display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:6px"
		}, [
			E("strong", {}, ["Selective block #" + (index + 1)]),
			E("button", {
				"class": "cbi-button cbi-button-remove",
				"type": "button",
				"click": function(ev) {
					ev.preventDefault();
					onRemove();
				}
			}, ["Remove"])
		]);

		var box = E("div", {
			"class": "route-sel-block",
			"style": "border:1px dashed var(--border-color-soft,#ccc); border-radius:4px; padding:10px; margin:8px 0; background:var(--background-color-medium,#fff)"
		}, [
			header,
			this.fieldRow("Label", labelIn, "Used as [selective.<label>] when multiple blocks exist"),
			this.fieldRow("Enabled", enabledWrap),
			this.fieldRow("Device", deviceIn),
			this.fieldRow("Domains", domainsTa),
			this.fieldRow("Lists", listsTa)
		]);

		box._collect = function() {
			return {
				label: (labelIn.value || "").trim() || ("sel" + (index + 1)),
				enabled: !!(enabledWrap.querySelector("input") && enabledWrap.querySelector("input").checked),
				device: (deviceIn.value || "").trim(),
				domains: self.splitLines(domainsTa.value),
				lists: self.splitLines(listsTa.value)
			};
		};

		return box;
	},

	renderEditForm: function(state) {
		var self = this;
		var model = state.model;
		var idLocked = state.idLocked;

		var idInput = this.textInput(state.id || "", {
			"placeholder": "profile id (e.g. brr)",
			"disabled": idLocked ? "disabled" : null
		});
		var nameInput = this.textInput(model.name || "");
		var descInput = this.textInput(model.description || "");
		var routeType = this.selectInput(model.route.type || "interface", [
			{ value: "direct", label: "direct (WAN)" },
			{ value: "interface", label: "interface (VPN / custom)" }
		]);
		var routeDevice = this.textInput(model.route.device || "", {
			"placeholder": "e.g. awg_brr, wan"
		});
		var routeGateway = this.textInput(model.route.gateway || "", {
			"placeholder": "optional (direct only / override)"
		});

		var geoEnabled = this.checkboxInput(model.geoip.enabled, "Enabled");
		var geoSource = this.textInput(model.geoip.source_url || "", {
			"placeholder": "prefix-list URL"
		});
		var geoDomains = this.textArea((model.geoip.domains || []).join("\n"), {
			"placeholder": "one domain per line",
			"style": "width:100%; box-sizing:border-box; font-family:monospace; min-height:5em; white-space:pre"
		});
		var geoLists = this.textArea((model.geoip.lists || []).join("\n"), {
			"placeholder": "one list URL/path per line",
			"style": "width:100%; box-sizing:border-box; font-family:monospace; min-height:4em; white-space:pre"
		});

		var applyCheck = this.checkboxInput(false, "Apply after save");
		var rawTa = this.textArea("", {
			"style": "width:100%; box-sizing:border-box; font-family:monospace; min-height:18em; white-space:pre",
			"spellcheck": "false"
		});

		var selContainer = E("div", { "class": "route-sel-list" });
		var selEditors = [];

		var rebuildSelective = function(blocks) {
			selEditors = [];
			dom.content(selContainer, []);
			(blocks || []).forEach(function(block, idx) {
				var editor = self.buildSelectiveEditor(block, idx, function() {
					var data = collectSelective();
					data.splice(idx, 1);
					if (!data.length) {
						data.push({
							label: "default",
							enabled: false,
							device: "",
							domains: [],
							lists: []
						});
					}
					rebuildSelective(data);
				});
				selEditors.push(editor);
				selContainer.appendChild(editor);
			});
		};

		var collectSelective = function() {
			return selEditors.map(function(ed) { return ed._collect(); });
		};

		rebuildSelective(model.selective);

		var addSelBtn = E("button", {
			"class": "cbi-button cbi-button-add",
			"type": "button",
			"click": function(ev) {
				ev.preventDefault();
				var data = collectSelective();
				if (data.length >= MAX_SELECTIVE) {
					ui.addNotification(null, E("p", ["At most " + MAX_SELECTIVE + " selective blocks"]));
					return;
				}
				data.push({
					label: "sel" + (data.length + 1),
					enabled: false,
					device: "",
					domains: [],
					lists: []
				});
				rebuildSelective(data);
			}
		}, ["Add selective block"]);

		var formPane = E("div", { "class": "route-edit-form" }, [
			this.sectionBox("Identity", [
				this.fieldRow("Profile ID", idInput, idLocked
					? "Built-in / existing id (save overwrites this file)"
					: "Cannot be “direct”. Leave blank to derive from name."),
				this.fieldRow("Name", nameInput),
				this.fieldRow("Description", descInput)
			]),
			this.sectionBox("Default route", [
				this.fieldRow("Type", routeType),
				this.fieldRow("Device", routeDevice, "OpenWrt interface or kernel device (awg_brr, wan, …)"),
				this.fieldRow("Gateway", routeGateway, "Usually empty; auto from WAN DHCP when type=direct")
			]),
			this.sectionBox("Selective domain routing", [
				E("p", {
					"class": "cbi-section-descr",
					"style": "margin-top:0"
				}, ["Up to " + MAX_SELECTIVE + " enabled blocks. Each can target a different device."]),
				selContainer,
				E("p", {}, [addSelBtn])
			]),
			this.sectionBox("GeoIP WAN bypass", [
				this.fieldRow("Enabled", geoEnabled),
				this.fieldRow("Source URL", geoSource),
				this.fieldRow("Domains", geoDomains),
				this.fieldRow("Lists", geoLists)
			]),
			E("p", { "style": "margin:8px 0" }, [applyCheck])
		]);

		var rawPane = E("div", {
			"class": "route-edit-raw",
			"style": "display:none"
		}, [
			E("p", { "class": "cbi-section-descr" }, [
				"Raw TOML. Switching back to Form re-parses this text."
			]),
			rawTa
		]);

		var mode = "form";
		var modeFormBtn = E("button", {
			"class": "cbi-button cbi-button-action",
			"type": "button",
			"style": "margin-right:4px"
		}, ["Form"]);
		var modeRawBtn = E("button", {
			"class": "cbi-button cbi-button-neutral",
			"type": "button"
		}, ["Raw TOML"]);

		var collectModel = function() {
			return {
				name: (nameInput.value || "").trim(),
				description: (descInput.value || "").trim(),
				route: {
					type: routeType.value || "direct",
					device: (routeDevice.value || "").trim(),
					gateway: (routeGateway.value || "").trim()
				},
				selective: collectSelective(),
				geoip: {
					enabled: !!(geoEnabled.querySelector("input") && geoEnabled.querySelector("input").checked),
					source_url: (geoSource.value || "").trim(),
					domains: self.splitLines(geoDomains.value),
					lists: self.splitLines(geoLists.value)
				}
			};
		};

		var applyModelToForm = function(m) {
			nameInput.value = m.name || "";
			descInput.value = m.description || "";
			routeType.value = m.route.type || "interface";
			routeDevice.value = m.route.device || "";
			routeGateway.value = m.route.gateway || "";
			if (geoEnabled.querySelector("input"))
				geoEnabled.querySelector("input").checked = !!m.geoip.enabled;
			geoSource.value = m.geoip.source_url || "";
			geoDomains.value = (m.geoip.domains || []).join("\n");
			geoLists.value = (m.geoip.lists || []).join("\n");
			rebuildSelective(m.selective);
		};

		var setMode = function(next) {
			if (next === mode)
				return;
			if (next === "raw") {
				rawTa.value = self.serializeProfileToml(collectModel());
				formPane.style.display = "none";
				rawPane.style.display = "";
				modeFormBtn.className = "cbi-button cbi-button-neutral";
				modeRawBtn.className = "cbi-button cbi-button-action";
			} else {
				try {
					applyModelToForm(self.parseProfileToml(rawTa.value));
				} catch (e) {
					ui.addNotification(null, E("p", ["Could not parse TOML: " + e]));
					return;
				}
				formPane.style.display = "";
				rawPane.style.display = "none";
				modeFormBtn.className = "cbi-button cbi-button-action";
				modeRawBtn.className = "cbi-button cbi-button-neutral";
			}
			mode = next;
		};

		modeFormBtn.addEventListener("click", function(ev) {
			ev.preventDefault();
			setMode("form");
		});
		modeRawBtn.addEventListener("click", function(ev) {
			ev.preventDefault();
			setMode("raw");
		});

		var statusLine = E("p", {
			"class": "route-edit-status",
			"style": "min-height:1.2em; font-style:italic; opacity:0.85"
		}, [state.note || ""]);

		var body = E("div", {
			"class": "route-edit-dialog",
			"style": "max-height:70vh; overflow:auto; padding-right:4px"
		}, [
			E("div", { "style": "margin-bottom:10px" }, [modeFormBtn, " ", modeRawBtn]),
			statusLine,
			formPane,
			rawPane
		]);

		return {
			node: body,
			getId: function() {
				return (idInput.value || "").trim();
			},
			getToml: function() {
				if (mode === "raw")
					return rawTa.value;
				return self.serializeProfileToml(collectModel());
			},
			wantApply: function() {
				var input = applyCheck.querySelector("input");
				return !!(input && input.checked);
			},
			setStatus: function(text) {
				dom.content(statusLine, [text || ""]);
			},
			validate: function() {
				var id = (idInput.value || "").trim();
				if (id === "direct")
					return "Cannot overwrite built-in profile “direct”. Choose another id.";
				var toml = this.getToml();
				if (!String(toml || "").trim())
					return "Profile is empty";
				var m = mode === "raw" ? self.parseProfileToml(toml) : collectModel();
				if (m.route.type === "interface" && !(m.route.device || "").trim())
					return "route.device is required when type=interface";
				var enabled = (m.selective || []).filter(function(b) { return b.enabled; });
				if (enabled.length > MAX_SELECTIVE)
					return "At most " + MAX_SELECTIVE + " enabled selective blocks";
				for (var i = 0; i < enabled.length; i++) {
					if (!(enabled[i].device || "").trim() && m.route.type !== "interface")
						return "Selective block “" + enabled[i].label + "” needs a device (or set route.type=interface with route.device)";
				}
				return null;
			}
		};
	},

	handleEdit: function(id) {
		var self = this;
		ui.showModal("Edit profile", [
			E("p", { "class": "spinning" }, ["Loading " + id + "…"])
		]);

		return this.callRouteProfiles(["show", id]).then(function(output) {
			var text = output || "";
			// show prints file contents; strip accidental stderr prefixes
			if (/^Usage:|^Profile not found:|^Error:/m.test(text) && text.length < 200)
				throw new Error(text.trim());

			var model = self.parseProfileToml(text);
			var locked = (id !== "direct"); // direct must be saved under a new id
			// For direct, force save-as
			var editId = id === "direct" ? "" : id;
			var note = id === "direct"
				? "Built-in direct cannot be overwritten — pick a new profile id to save a copy."
				: ("Editing /etc/route-profiles/profiles/" + id + ".toml");

			var form = self.renderEditForm({
				id: editId,
				idLocked: locked && id !== "direct",
				model: model,
				note: note
			});

			// Re-open with full UI
			var saveBtn = E("button", {
				"class": "cbi-button cbi-button-positive important",
				"style": "margin-left:6px"
			}, ["Save"]);
			var cancelBtn = E("button", {
				"class": "cbi-button cbi-button-neutral",
				"click": ui.hideModal
			}, ["Cancel"]);

			var busy = false;
			saveBtn.addEventListener("click", function(ev) {
				ev.preventDefault();
				if (busy) return;

				var err = form.validate();
				if (err) {
					form.setStatus(err);
					ui.addNotification(null, E("p", [err]));
					return;
				}

				var saveId = form.getId();
				if (!saveId) {
					// derive from name
					saveId = (form.getToml().match(/^name\s*=\s*"([^"]+)"/m) || [])[1] || id;
					saveId = String(saveId).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
				}
				if (!saveId || saveId === "direct") {
					form.setStatus("Set a profile id (not “direct”)");
					ui.addNotification(null, E("p", ["Set a profile id (not “direct”)"]));
					return;
				}

				busy = true;
				saveBtn.setAttribute("disabled", "true");
				form.setStatus("Saving " + saveId + "…");

				var toml = form.getToml();
				fs.write(UPLOAD_PATH, toml).then(function() {
					return self.callRouteProfiles(["import", UPLOAD_PATH, saveId]);
				}).then(function(out) {
					self.setOutput(out);
					ui.addNotification(null, E("p", ["Saved profile " + saveId]));
					var apply = form.wantApply();
					ui.hideModal();
					if (apply)
						return self.handleApply(saveId);
					return self.refreshList();
				}).catch(function(e) {
					var msg = self.formatError(e);
					form.setStatus(msg);
					ui.addNotification(null, E("p", [msg]));
					self.setOutput(msg);
				}).finally(function() {
					busy = false;
					saveBtn.removeAttribute("disabled");
				});
			});

			ui.showModal("Edit profile: " + id, [
				form.node,
				E("div", {
					"class": "right",
					"style": "margin-top:12px; display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap"
				}, [cancelBtn, saveBtn])
			], "route-profiles-edit-modal");

			// Widen modal when possible
			var modal = document.querySelector(".modal.route-profiles-edit-modal") ||
				document.querySelector(".modal");
			if (modal) {
				modal.style.maxWidth = "720px";
				modal.style.width = "92vw";
			}
		}).catch(function(err) {
			ui.hideModal();
			var msg = self.formatError(err);
			self.setOutput(msg);
			ui.addNotification(null, E("p", [msg]));
		});
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
				"Upload or apply another profile (for example BRR) to switch the router policy. ",
				"Use Edit to change a profile with the form UI."
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
					"Edit opens a dialog to change the TOML via form or raw text. ",
					"Built-in direct cannot be deleted or overwritten."
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
