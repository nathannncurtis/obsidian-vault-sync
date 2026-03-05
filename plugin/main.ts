import { Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, Notice, App } from "obsidian";

interface VaultSyncSettings {
	serverUrl: string;
	authToken: string;
	syncInterval: number;
	autoSync: boolean;
}

const DEFAULT_SETTINGS: VaultSyncSettings = {
	serverUrl: "https://notes.nathancurtis.to",
	authToken: "",
	syncInterval: 30,
	autoSync: true,
};

const IGNORE_PATHS = new Set([
	".obsidian/workspace.json",
	".obsidian/workspace-mobile.json",
	".obsidian/community-plugins.json",
	".obsidian/hotkeys.json",
]);

function shouldIgnore(path: string): boolean {
	if (IGNORE_PATHS.has(path)) return true;
	if (path.startsWith(".trash/")) return true;
	if (path.endsWith(".DS_Store")) return true;
	return false;
}

async function computeHash(content: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", content);
	const hashArray = new Uint8Array(hashBuffer);
	let hex = "";
	for (let i = 0; i < hashArray.length; i++) {
		hex += hashArray[i].toString(16).padStart(2, "0");
	}
	return hex;
}

interface RemoteFileInfo {
	hash: string;
	mtime: number;
}

interface RemoteChangeMsg {
	event: string;
	path: string;
	hash?: string;
	mtime?: number;
}

export default class VaultSyncPlugin extends Plugin {
	settings: VaultSyncSettings = DEFAULT_SETTINGS;
	ws: WebSocket | null = null;
	syncing = false;
	statusBarEl!: HTMLElement;
	syncStatus: "connected" | "syncing" | "error" | "disconnected" = "disconnected";
	remoteFiles: Map<string, RemoteFileInfo> = new Map();
	localHashes: Map<string, string> = new Map();
	debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	pollingInterval: ReturnType<typeof setInterval> | null = null;
	suppressNextRemote: Set<string> = new Set();
	suppressNextLocal: Set<string> = new Set();
	reconnectDelay = 5000;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new VaultSyncSettingTab(this.app, this));
		this.statusBarEl = this.addStatusBarItem();
		this.setStatus("disconnected");

		if (this.settings.autoSync && this.settings.authToken) {
			this.connectWS();
		}

		this.registerEvent(this.app.vault.on("create", (file) => this.handleLocalChange(file, "create")));
		this.registerEvent(this.app.vault.on("modify", (file) => this.handleLocalChange(file, "modify")));
		this.registerEvent(this.app.vault.on("delete", (file) => this.handleLocalChange(file, "delete")));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			this.handleLocalChange({ path: oldPath } as TFile, "delete");
			this.handleLocalChange(file, "create");
		}));

		this.addCommand({
			id: "force-full-sync",
			name: "Force full sync",
			callback: () => this.initialSync(),
		});

		this.addCommand({
			id: "toggle-sync",
			name: "Toggle sync",
			callback: () => {
				this.settings.autoSync = !this.settings.autoSync;
				this.saveSettings();
				if (this.settings.autoSync) {
					this.connectWS();
				} else {
					this.disconnectWS();
				}
				new Notice(`Vault sync ${this.settings.autoSync ? "enabled" : "disabled"}`);
			},
		});
	}

	onunload() {
		this.disconnectWS();
		for (const timer of this.debounceTimers.values()) clearTimeout(timer);
		this.debounceTimers.clear();
		this.stopPolling();
	}

	setStatus(status: "connected" | "syncing" | "error" | "disconnected") {
		this.syncStatus = status;
		this.statusBarEl.innerHTML = `<span class="vault-sync-status"><span class="sync-icon ${status}"></span> Sync: ${status}</span>`;
	}

	async apiRequest(method: string, endpoint: string, body?: FormData | null, binary?: boolean): Promise<any> {
		const url = `${this.settings.serverUrl}${endpoint}`;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.settings.authToken}`,
		};

		try {
			const opts: RequestInit = { method, headers };
			if (body) opts.body = body;

			const res = await fetch(url, opts);
			if (res.status === 401) {
				this.setStatus("error");
				new Notice("Sync auth failed");
				return null;
			}
			if (!res.ok) {
				this.setStatus("error");
				return null;
			}
			if (binary) return await res.arrayBuffer();
			return await res.json();
		} catch (e) {
			this.setStatus("error");
			console.error("Vault sync API error:", e);
			return null;
		}
	}

	connectWS() {
		if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

		const wsUrl = this.settings.serverUrl
			.replace("https://", "wss://")
			.replace("http://", "ws://");
		const url = `${wsUrl}/api/ws?token=${encodeURIComponent(this.settings.authToken)}`;

		this.ws = new WebSocket(url);
		this.reconnectDelay = 5000;

		this.ws.onopen = () => {
			this.setStatus("connected");
			this.stopPolling();
			this.initialSync();
		};

		this.ws.onmessage = (ev) => {
			try {
				const msg: RemoteChangeMsg = JSON.parse(ev.data);
				this.handleRemoteChange(msg);
			} catch (e) {
				console.error("Vault sync WS parse error:", e);
			}
		};

		this.ws.onclose = () => {
			this.setStatus("disconnected");
			this.ws = null;
			this.startPolling();
			setTimeout(() => {
				if (this.settings.autoSync && this.settings.authToken) {
					this.connectWS();
				}
			}, this.reconnectDelay);
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
		};

		this.ws.onerror = () => {
			this.setStatus("error");
		};
	}

	disconnectWS() {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this.stopPolling();
		this.setStatus("disconnected");
	}

	startPolling() {
		if (this.pollingInterval) return;
		this.pollingInterval = setInterval(() => this.pollSync(), this.settings.syncInterval * 1000);
	}

	stopPolling() {
		if (this.pollingInterval) {
			clearInterval(this.pollingInterval);
			this.pollingInterval = null;
		}
	}

	async pollSync() {
		const files = await this.apiRequest("GET", "/api/files");
		if (!files) return;

		const newRemote = new Map<string, RemoteFileInfo>();
		for (const f of files) {
			newRemote.set(f.path, { hash: f.hash, mtime: f.mtime });
		}

		for (const [path, info] of newRemote) {
			if (shouldIgnore(path)) continue;
			const prev = this.remoteFiles.get(path);
			if (!prev || prev.hash !== info.hash) {
				await this.handleRemoteChange({ event: "changed", path, hash: info.hash, mtime: info.mtime });
			}
		}

		for (const path of this.remoteFiles.keys()) {
			if (!newRemote.has(path)) {
				await this.handleRemoteChange({ event: "deleted", path });
			}
		}

		this.remoteFiles = newRemote;
	}

	async initialSync() {
		if (this.syncing) return;
		this.syncing = true;
		this.setStatus("syncing");

		try {
			const remoteList = await this.apiRequest("GET", "/api/files");
			if (!remoteList) {
				this.syncing = false;
				return;
			}

			const remoteMap = new Map<string, RemoteFileInfo>();
			for (const f of remoteList) {
				remoteMap.set(f.path, { hash: f.hash, mtime: f.mtime });
			}

			const localFiles = this.app.vault.getFiles();
			const localMap = new Map<string, TFile>();
			for (const f of localFiles) {
				if (!shouldIgnore(f.path)) {
					localMap.set(f.path, f);
				}
			}

			// compute local hashes
			for (const [path, file] of localMap) {
				const content = await this.app.vault.readBinary(file.path);
				const hash = await computeHash(content);
				this.localHashes.set(path, hash);
			}

			// sync remote → local
			for (const [path, info] of remoteMap) {
				if (shouldIgnore(path)) continue;
				const localFile = localMap.get(path);
				const localHash = this.localHashes.get(path);

				if (!localFile) {
					// not local, download
					const content = await this.apiRequest("GET", `/api/file?path=${encodeURIComponent(path)}`, null, true);
					if (content) {
						this.suppressNextLocal.add(path);
						await this.ensureFolder(path);
						await this.app.vault.createBinary(path, content);
						this.localHashes.set(path, info.hash);
					}
				} else if (localHash !== info.hash) {
					const localMtime = (localFile.stat.mtime / 1000);
					if (info.mtime > localMtime) {
						// remote is newer, download
						const content = await this.apiRequest("GET", `/api/file?path=${encodeURIComponent(path)}`, null, true);
						if (content) {
							this.suppressNextLocal.add(path);
							await this.app.vault.modifyBinary(localFile, content);
							this.localHashes.set(path, info.hash);
						}
					} else {
						// local is newer, upload
						const content = await this.app.vault.readBinary(localFile.path);
						const form = new FormData();
						form.append("path", path);
						form.append("content", new Blob([content]));
						form.append("mtime", String(localFile.stat.mtime / 1000));
						const res = await this.apiRequest("POST", "/api/file", form);
						if (res) {
							this.suppressNextRemote.add(path);
							this.localHashes.set(path, localHash!);
						}
					}
				}
			}

			// sync local → remote (files not on server)
			for (const [path, file] of localMap) {
				if (!remoteMap.has(path)) {
					const content = await this.app.vault.readBinary(file.path);
					const form = new FormData();
					form.append("path", path);
					form.append("content", new Blob([content]));
					form.append("mtime", String(file.stat.mtime / 1000));
					const res = await this.apiRequest("POST", "/api/file", form);
					if (res) {
						this.suppressNextRemote.add(path);
					}
				}
			}

			this.remoteFiles = remoteMap;
			this.setStatus("connected");
			new Notice("Vault sync complete");
		} catch (e) {
			console.error("Vault sync initial sync error:", e);
			this.setStatus("error");
		} finally {
			this.syncing = false;
		}
	}

	handleLocalChange(file: TAbstractFile, type: string) {
		if (!(file instanceof TFile) && type !== "delete") return;
		if (shouldIgnore(file.path)) return;
		if (this.suppressNextLocal.has(file.path)) {
			this.suppressNextLocal.delete(file.path);
			return;
		}
		if (!this.settings.autoSync) return;

		const existing = this.debounceTimers.get(file.path);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(async () => {
			this.debounceTimers.delete(file.path);
			try {
				if (type === "delete") {
					await this.apiRequest("DELETE", `/api/file?path=${encodeURIComponent(file.path)}`);
					this.localHashes.delete(file.path);
					this.remoteFiles.delete(file.path);
				} else {
					const content = await this.app.vault.readBinary(file.path);
					const hash = await computeHash(content);
					if (hash === this.localHashes.get(file.path)) return;

					const tfile = file as TFile;
					const form = new FormData();
					form.append("path", file.path);
					form.append("content", new Blob([content]));
					form.append("mtime", String(tfile.stat.mtime / 1000));
					const res = await this.apiRequest("POST", "/api/file", form);
					if (res) {
						this.localHashes.set(file.path, hash);
						this.remoteFiles.set(file.path, { hash, mtime: tfile.stat.mtime / 1000 });
						this.suppressNextRemote.add(file.path);
					}
				}
			} catch (e) {
				console.error("Vault sync local change error:", e);
			}
		}, 1000);

		this.debounceTimers.set(file.path, timer);
	}

	async handleRemoteChange(msg: RemoteChangeMsg) {
		if (shouldIgnore(msg.path)) return;
		if (this.suppressNextRemote.has(msg.path)) {
			this.suppressNextRemote.delete(msg.path);
			return;
		}

		try {
			if (msg.event === "changed") {
				if (msg.hash === this.localHashes.get(msg.path)) return;

				const content = await this.apiRequest("GET", `/api/file?path=${encodeURIComponent(msg.path)}`, null, true);
				if (!content) return;

				this.suppressNextLocal.add(msg.path);
				const existing = this.app.vault.getAbstractFileByPath(msg.path);
				if (existing && existing instanceof TFile) {
					await this.app.vault.modifyBinary(existing, content);
				} else {
					await this.ensureFolder(msg.path);
					await this.app.vault.createBinary(msg.path, content);
				}

				this.localHashes.set(msg.path, msg.hash!);
				this.remoteFiles.set(msg.path, { hash: msg.hash!, mtime: msg.mtime! });
			} else if (msg.event === "deleted") {
				const existing = this.app.vault.getAbstractFileByPath(msg.path);
				if (existing) {
					this.suppressNextLocal.add(msg.path);
					await this.app.vault.delete(existing);
				}
				this.localHashes.delete(msg.path);
				this.remoteFiles.delete(msg.path);
			}
		} catch (e) {
			console.error("Vault sync remote change error:", e);
		}
	}

	async ensureFolder(filePath: string) {
		const parts = filePath.split("/");
		parts.pop(); // remove filename
		if (parts.length === 0) return;
		const folderPath = parts.join("/");
		const existing = this.app.vault.getAbstractFileByPath(folderPath);
		if (!existing) {
			try {
				await this.app.vault.createFolder(folderPath);
			} catch {
				// folder might already exist
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class VaultSyncSettingTab extends PluginSettingTab {
	plugin: VaultSyncPlugin;

	constructor(app: App, plugin: VaultSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("URL of the sync server")
			.addText((text) =>
				text
					.setPlaceholder("https://notes.nathancurtis.to")
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auth Token")
			.setDesc("Shared secret for authentication")
			.addText((text) => {
				text
					.setPlaceholder("Enter token")
					.setValue(this.plugin.settings.authToken)
					.onChange(async (value) => {
						this.plugin.settings.authToken = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Sync Interval")
			.setDesc("Polling fallback interval in seconds")
			.addDropdown((drop) =>
				drop
					.addOptions({ "10": "10s", "15": "15s", "30": "30s", "60": "60s" })
					.setValue(String(this.plugin.settings.syncInterval))
					.onChange(async (value) => {
						this.plugin.settings.syncInterval = parseInt(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto Sync")
			.setDesc("Automatically sync on startup")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSync)
					.onChange(async (value) => {
						this.plugin.settings.autoSync = value;
						await this.plugin.saveSettings();
						if (value) {
							this.plugin.connectWS();
						} else {
							this.plugin.disconnectWS();
						}
					})
			);

		new Setting(containerEl)
			.setName("Test Connection")
			.addButton((btn) =>
				btn.setButtonText("Test").onClick(async () => {
					try {
						const res = await fetch(`${this.plugin.settings.serverUrl}/api/ping`);
						const data = await res.json();
						new Notice(data.status === "ok" ? "Connection successful" : "Unexpected response");
					} catch {
						new Notice("Connection failed");
					}
				})
			);

		new Setting(containerEl)
			.setName("Force Full Sync")
			.addButton((btn) =>
				btn.setButtonText("Sync Now").onClick(() => {
					this.plugin.initialSync();
				})
			);
	}
}
