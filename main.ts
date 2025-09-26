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

/** -------------------- Settings Interface -------------------- */
interface PluginSettings {
  serverUrl: string;     // ej: http://127.0.0.1:5000
  language: string;      // "auto", "es", "en", ...
}

const DEFAULT_SETTINGS: PluginSettings = {
  serverUrl: "http://127.0.0.1:5000",
  language: "auto"
};

/** -------------------- Plugin -------------------- */
export default class WisperLocalServerPlugin extends Plugin {
  settings!: PluginSettings;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // Crear carpeta Audio y Transcripts si no existen
    try { await this.app.vault.createFolder("Audio"); } catch (_) {}
    try { await this.app.vault.createFolder("Transcripts"); } catch (_) {}

    // Ribbon: seleccionar archivo y transcribir
    this.addRibbonIcon("mic", "Transcribir archivo (Whisper local)", async () => {
      const audio = await this.pickAudioFile("Audio");
      if (audio) await this.transcribeAudioFile(audio);
    });

    // Ribbon: grabar y transcribir
    this.addRibbonIcon("circle-dot", "Grabar y transcribir (Whisper local)", async () => {
      new RecorderModal(this.app, async (file) => {
        if (file) await this.transcribeAudioFile(file);
      }).open();
    });

    // Comando: probar servidor
    this.addCommand({
      id: "wisper-local-test-server",
      name: "Probar servidor Whisper local",
      callback: async () => {
        try {
          const url = `${this.settings.serverUrl.replace(/\/$/, "")}/health`;
          const res = await requestUrl({ url, method: "GET" });
          console.log("Health response:", res);
          if (res && res.json && res.json.ok) {
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

    this.addSettingTab(new SettingsTab(this.app, this));
  }

  onunload() {}

  /** -------------------- Selección de archivos -------------------- */
  private async pickAudioFile(dir = "Audio"): Promise<TFile | null> {
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
      // Leer binario y convertir a base64
      const arrayBuf = await (this.app.vault as any).readBinary(file);
      const base64 = this.arrayBufferToBase64(arrayBuf);
      const format = file.extension.toLowerCase();

      const payload = {
        filename: file.name,
        data: base64,
        format: format,
        language: (this.settings.language || "auto")
      };

      const url = `${this.settings.serverUrl.replace(/\/$/, "")}/transcribe`;
      console.log("POST a:", url, "archivo:", file.name);

      const res = await requestUrl({
        url,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (res.status !== 200) {
        console.error("Respuesta error:", res);
        new Notice(`Error del servidor (status ${res.status}).`);
        return;
      }

      const json = res.json;
      if (!json || json.ok !== true) {
        console.error("Respuesta no OK:", json);
        new Notice("Servidor devolvió error. Ver consola.");
        return;
      }

      const transcript = (json.text || "").trim();
      if (!transcript) {
        new Notice("Servidor respondió OK pero sin texto.");
        return;
      }

      await this.saveTranscriptFile(file, transcript);
      new Notice("Transcripción guardada en Transcripts/");
    } catch (err: any) {
      console.error("Error transcribiendo:", err);
      new Notice("Fallo al contactar servidor (ver consola).");
    }
  }

  /** -------------------- Guardar resultado en archivo nuevo -------------------- */
  private async saveTranscriptFile(srcFile: TFile, text: string) {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const dir = "Transcripts";
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
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
    }
    return btoa(binary);
  }
}

/** -------------------- Modal grabadora -------------------- */
class RecorderModal extends Modal {
  private chunks: BlobPart[] = [];
  private recorder: MediaRecorder | null = null;
  private onFinish: (file: TFile | null) => void;

  constructor(app: App, onFinish: (file: TFile | null) => void) {
    super(app);
    this.onFinish = onFinish;
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
          const path = `Audio/${baseName}`;
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

/** -------------------- Modal selector de audio -------------------- */
class AudioFileSuggestModal extends SuggestModal<TFile> {
  private files: TFile[];
  private resolver!: (file: TFile | null) => void;

  constructor(app: App, files: TFile[]) {
    super(app);
    this.files = files;
    this.setPlaceholder("Selecciona un archivo en /Audio …");
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
  }
}
