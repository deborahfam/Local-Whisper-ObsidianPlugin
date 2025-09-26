import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  TFile,
  requestUrl
} from "obsidian";

interface PluginSettings {
  serverUrl: string;
  language: string;
  audioFolder: string;
  transcriptsFolder: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
  serverUrl: "http://127.0.0.1:5000",
  language: "auto",
  audioFolder: "Audio",
  transcriptsFolder: "Transcripts"
};

export default class WisperLocalServerPlugin extends Plugin {
  settings!: PluginSettings;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // Crear carpetas configuradas si no existen
    try { await this.app.vault.createFolder(this.settings.audioFolder); } catch (_) {}
    try { await this.app.vault.createFolder(this.settings.transcriptsFolder); } catch (_) {}

    // Ribbon: grabar y transcribir
    this.addRibbonIcon("circle-dot", "Grabar y transcribir (Whisper local)", async () => {
      new RecorderModal(this.app, async (file) => {
        if (file) await this.transcribeAudioFile(file);
      }, this.settings.audioFolder).open();
    });

    // Comando: probar servidor
    this.addCommand({
      id: "wisper-local-test-server",
      name: "Probar servidor Whisper local",
      callback: async () => {
        try {
          const url = `${this.settings.serverUrl.replace(/\/$/, "")}/health`;
          const res = await requestUrl({ url, method: "GET" });
          if (res?.json?.ok) {
            new Notice(`Servidor OK (modelo ${res.json.model})`);
          } else {
            new Notice("Respuesta inesperada del servidor (ver consola).");
          }
        } catch (err: any) {
          console.error("Error probando servidor:", err);
          new Notice("Fallo al contactar servidor (ver consola).");
        }
      }
    });

    // Comando: transcribir archivo existente
    this.addCommand({
      id: "wisper-local-transcribe-existing",
      name: "Transcribir archivo de audio existente",
      callback: async () => {
        const audio = await this.pickAudioFile(this.settings.audioFolder);
        if (audio) await this.transcribeAudioFile(audio);
      }
    });

    this.addSettingTab(new SettingsTab(this.app, this));
  }

  onunload() {}

  /** -------------------- Selección de archivos -------------------- */
  private async pickAudioFile(dir: string): Promise<TFile | null> {
    const files = this.app.vault.getFiles()
      .filter(f => this.isSupportedAudio(f) && f.path.startsWith(dir + "/"));
    if (files.length === 0) {
      new Notice(`No encontré audios en la carpeta ${dir}/`);
      return null;
    }
    return await new AudioFileSuggestModal(this.app, files).openAndGet();
  }

  private isSupportedAudio(f: TFile): boolean {
    const ext = (f.extension || "").toLowerCase();
    return ["mp3", "wav", "webm", "m4a", "flac"].includes(ext);
  }

  /** -------------------- Transcripción -------------------- */
  private async transcribeAudioFile(file: TFile) {
    new Notice(`Enviando a Whisper local: ${file.name} …`);
    try {
      const arrayBuf = await this.app.vault.adapter.readBinary(file.path);
      const base64 = this.arrayBufferToBase64(arrayBuf);
      const format = file.extension.toLowerCase();

      const payload = {
        filename: file.name,
        data: base64,
        format: format,
        language: this.settings.language || "auto"
      };

      const url = `${this.settings.serverUrl.replace(/\/$/, "")}/transcribe`;
      const res = await requestUrl({
        url,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        throw: false
      });

      if (res.status !== 200) {
        console.error("Respuesta error:", res);
        new Notice(`Error del servidor (status ${res.status}).`);
        return;
      }

      const json = res.json;
      if (!json?.ok) {
        console.error("Servidor devolvió error:", json);
        new Notice("Servidor devolvió error. Ver consola.");
        return;
      }

      const transcript = (json.text || "").trim();
      if (!transcript) {
        new Notice("Servidor respondió OK pero sin texto.");
        return;
      }

      await this.saveTranscriptFile(file, transcript);
      new Notice("✅ Transcripción guardada.");
    } catch (err: any) {
      console.error("Error transcribiendo:", err);
      new Notice("Fallo al contactar servidor (ver consola).");
    }
  }

  /** -------------------- Guardar transcripción -------------------- */
  private async saveTranscriptFile(srcFile: TFile, text: string) {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const dir = this.settings.transcriptsFolder;
    const baseName = srcFile.basename.replace(/[\/\\:*?"<>|]+/g, "_");
    const newPath = `${dir}/${baseName}.${stamp}.md`;
    const content = `# Transcripción de ${srcFile.name}\n\n${text}\n`;
    await this.app.vault.create(newPath, content);
  }

  /** -------------------- Utilidades -------------------- */
  private arrayBufferToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
}

/** -------------------- Modal grabadora -------------------- */
class RecorderModal extends Modal {
  private chunks: BlobPart[] = [];
  private recorder: MediaRecorder | null = null;
  private onFinish: (file: TFile | null) => void;
  private audioFolder: string;

  constructor(app: App, onFinish: (file: TFile | null) => void, audioFolder: string) {
    super(app);
    this.onFinish = onFinish;
    this.audioFolder = audioFolder;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Grabadora de audio" });

    const startBtn = contentEl.createEl("button", { text: "🎙️ Iniciar" });
    const stopBtn = contentEl.createEl("button", { text: "⏹️ Detener" });
    stopBtn.disabled = true;

    startBtn.onclick = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.recorder = new MediaRecorder(stream);
        this.chunks = [];

        this.recorder.ondataavailable = (e) => this.chunks.push(e.data);
        this.recorder.onstop = async () => {
          const blob = new Blob(this.chunks, { type: "audio/webm" });
          const buf = await blob.arrayBuffer();
          const baseName = `grabacion-${Date.now()}.webm`;
          const path = `${this.audioFolder}/${baseName}`;
          const file = await this.app.vault.createBinary(path, buf);
          new Notice(`Grabación guardada en ${path}`);
          this.onFinish(file);
          this.close();
        };

        this.recorder.start();
        startBtn.disabled = true;
        stopBtn.disabled = false;
      } catch (err) {
        console.error(err);
        new Notice("No se pudo acceder al micrófono.");
      }
    };

    stopBtn.onclick = () => {
      if (this.recorder && this.recorder.state === "recording") {
        this.recorder.stop();
      }
    };
  }

  onClose() {
    this.onFinish(null);
  }
}

/** -------------------- Selector de audio -------------------- */
class AudioFileSuggestModal extends SuggestModal<TFile> {
  private files: TFile[];
  private resolver!: (file: TFile | null) => void;

  constructor(app: App, files: TFile[]) {
    super(app);
    this.files = files;
    this.setPlaceholder("Selecciona un archivo de audio…");
  }

  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase();
    return this.files.filter(f => f.path.toLowerCase().includes(q));
  }

  renderSuggestion(value: TFile, el: HTMLElement) {
    el.createEl("div", { text: value.path });
  }

  onChooseSuggestion(item: TFile) {
    if (this.resolver) this.resolver(item);
    this.close();
  }

  onClose() {
    if (this.resolver) this.resolver(null);
  }

  openAndGet(): Promise<TFile | null> {
    this.open();
    return new Promise<TFile | null>((resolve) => (this.resolver = resolve));
  }
}

/** -------------------- Settings Tab -------------------- */
class SettingsTab extends PluginSettingTab {
  plugin: WisperLocalServerPlugin;

  constructor(app: App, plugin: WisperLocalServerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Wisper (servidor local)" });

    new Setting(containerEl)
      .setName("URL del servidor")
      .setDesc("Ejemplo: http://127.0.0.1:5000")
      .addText(t => t
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async v => { this.plugin.settings.serverUrl = v.trim(); await this.plugin.saveData(this.plugin.settings); }));

    new Setting(containerEl)
      .setName("Idioma")
      .setDesc("auto, es, en…")
      .addText(t => t
        .setValue(this.plugin.settings.language)
        .onChange(async v => { this.plugin.settings.language = v.trim() || "auto"; await this.plugin.saveData(this.plugin.settings); }));

    new Setting(containerEl)
      .setName("Carpeta de audios")
      .setDesc("Dónde guardar las grabaciones y buscar audios")
      .addText(t => t
        .setValue(this.plugin.settings.audioFolder)
        .onChange(async v => { this.plugin.settings.audioFolder = v.trim() || "Audio"; await this.plugin.saveData(this.plugin.settings); }));

    new Setting(containerEl)
      .setName("Carpeta de transcripciones")
      .setDesc("Dónde guardar los archivos .md con transcripciones")
      .addText(t => t
        .setValue(this.plugin.settings.transcriptsFolder)
        .onChange(async v => { this.plugin.settings.transcriptsFolder = v.trim() || "Transcripts"; await this.plugin.saveData(this.plugin.settings); }));
  }
}
