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

export default class WhisperLocalServerPlugin extends Plugin {
  settings!: PluginSettings;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // Create folders if they don't exist
    try { await this.app.vault.createFolder(this.settings.audioFolder); } catch (_) {}
    try { await this.app.vault.createFolder(this.settings.transcriptsFolder); } catch (_) {}

    // Ribbon: record and transcribe
    this.addRibbonIcon("circle-dot", "Record & Transcribe (Local Whisper)", async () => {
      new RecorderModal(this.app, async (file) => {
        if (file) await this.transcribeAudioFile(file);
      }, this.settings.audioFolder).open();
    });

    // Command: test server
    this.addCommand({
      id: "whisper-local-test-server",
      name: "Test Local Whisper Server",
      callback: async () => {
        try {
          const url = `${this.settings.serverUrl.replace(/\/$/, "")}/health`;
          const res = await requestUrl({ url, method: "GET" });
          if (res?.json?.ok) {
            new Notice(`Server OK (model ${res.json.model})`);
          } else {
            new Notice("Unexpected server response (see console).");
          }
        } catch (err: any) {
          console.error("Error testing server:", err);
          new Notice("Failed to contact server (see console).");
        }
      }
    });

    // Command: transcribe existing file
    this.addCommand({
      id: "whisper-local-transcribe-existing",
      name: "Transcribe Existing Audio File",
      callback: async () => {
        const audio = await this.pickAudioFile(this.settings.audioFolder);
        if (audio) await this.transcribeAudioFile(audio);
      }
    });

    this.addSettingTab(new SettingsTab(this.app, this));
  }

  onunload() {}

  /** -------------------- File selection -------------------- */
  private async pickAudioFile(dir: string): Promise<TFile | null> {
    const files = this.app.vault.getFiles()
      .filter(f => this.isSupportedAudio(f) && f.path.startsWith(dir + "/"));
    if (files.length === 0) {
      new Notice(`No audio files found in ${dir}/`);
      return null;
    }
    return await new AudioFileSuggestModal(this.app, files).openAndGet();
  }

  private isSupportedAudio(f: TFile): boolean {
    const ext = (f.extension || "").toLowerCase();
    return ["mp3", "wav", "webm", "m4a", "flac"].includes(ext);
  }

  /** -------------------- Transcription -------------------- */
  private async transcribeAudioFile(file: TFile) {
    new Notice(`Sending to Local Whisper: ${file.name} …`);
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
        console.error("Server error response:", res);
        new Notice(`Server error (status ${res.status}).`);
        return;
      }

      const json = res.json;
      if (!json?.ok) {
        console.error("Server returned error:", json);
        new Notice("Server returned error. See console.");
        return;
      }

      const transcript = (json.text || "").trim();
      if (!transcript) {
        new Notice("Server returned OK but with empty text.");
        return;
      }

      await this.saveTranscriptFile(file, transcript);
      new Notice("✅ Transcript saved.");
    } catch (err: any) {
      console.error("Error transcribing:", err);
      new Notice("Failed to contact server (see console).");
    }
  }

  /** -------------------- Save transcript -------------------- */
  private async saveTranscriptFile(srcFile: TFile, text: string) {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const dir = this.settings.transcriptsFolder;
    const baseName = stamp; // transcript name matches timestamp
    const newPath = `${dir}/${baseName}.md`;
  
    // 🔗 Internal link to audio file
    const linkToAudio = `![[${srcFile.path}]]`;
  
    const content = `# Transcript (${stamp})\n\n**Audio file:** ${linkToAudio}\n\n---\n\n${text}\n`;
    await this.app.vault.create(newPath, content);
  }
  

  /** -------------------- Utilities -------------------- */
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

/** -------------------- Recorder Modal -------------------- */
class RecorderModal extends Modal {
  private chunks: BlobPart[] = [];
  private recorder: MediaRecorder | null = null;
  private onFinish: (file: TFile | null) => void;
  private audioFolder: string;
  private startTime: number = 0;
  private timerEl!: HTMLElement;
  private levelEl!: HTMLElement;
  private rafId: number = 0;
  private audioCtx!: AudioContext;
  private analyser!: AnalyserNode;

  constructor(app: App, onFinish: (file: TFile | null) => void, audioFolder: string) {
    super(app);
    this.onFinish = onFinish;
    this.audioFolder = audioFolder;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("recorder-modal");
  
    const header = contentEl.createEl("h2", { text: "Audio Recorder" });
    header.addClass("recorder-header");
  
    this.timerEl = contentEl.createEl("div", { text: "⏱️ 00:00", cls: "recorder-timer" });
  
    // Mic level bar container
    const levelContainer = contentEl.createEl("div", { cls: "recorder-level-container" });
    this.levelEl = levelContainer.createEl("div", { cls: "recorder-level-bar" });
  
    // Buttons container
    const btnContainer = contentEl.createEl("div", { cls: "recorder-buttons" });
  
    // NEW: Import Button
    const importBtn = btnContainer.createEl("button", { text: "📂 Import Audio", cls: "recorder-btn import" });
    
    const startBtn = btnContainer.createEl("button", { text: "🎙️ Start Recording", cls: "recorder-btn start" });
    const stopBtn = btnContainer.createEl("button", { text: "⏹️ Stop Recording", cls: "recorder-btn stop" });
    stopBtn.disabled = true;
  
    /** -------------------- Import Button -------------------- */
    importBtn.onclick = async () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".mp3,.wav,.webm,.m4a,.flac";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (file) {
          const arrayBuf = await file.arrayBuffer();
        
          const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
          const ext = file.name.split(".").pop() || "webm";
          const baseName = `${stamp}.${ext}`;
          const path = `${this.audioFolder}/${baseName}`;
        
          const obsFile = await this.app.vault.createBinary(path, arrayBuf);
          new Notice(`Imported audio: ${obsFile.name}`);
          this.onFinish(obsFile);
          this.close();
        }        
      };
      input.click();
    };
    
  
    /** -------------------- Start Button -------------------- */
    startBtn.onclick = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.audioCtx = new AudioContext();
        const src = this.audioCtx.createMediaStreamSource(stream);
        this.analyser = this.audioCtx.createAnalyser();
        src.connect(this.analyser);
  
        this.recorder = new MediaRecorder(stream);
        this.chunks = [];
  
        this.recorder.ondataavailable = (e) => this.chunks.push(e.data);
        this.recorder.onstop = async () => {
          cancelAnimationFrame(this.rafId);
          header.removeClass("recording");
        
          const blob = new Blob(this.chunks, { type: "audio/webm" });
          const buf = await blob.arrayBuffer();
        
          // 📅 File name: timestamp
          const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
          const baseName = `${stamp}.webm`;
          const path = `${this.audioFolder}/${baseName}`;
        
          const file = await this.app.vault.createBinary(path, buf);
          new Notice(`Recording saved to ${path}`);
          this.onFinish(file);
          this.close();
        };
        
  
        this.recorder.start();
        this.startTime = Date.now();
        this.updateTimer();
        this.updateLevel();
  
        header.addClass("recording");
        startBtn.disabled = true;
        stopBtn.disabled = false;
      } catch (err) {
        console.error(err);
        new Notice("Failed to access microphone.");
      }
    };
  
    /** -------------------- Stop Button -------------------- */
    stopBtn.onclick = () => {
      if (this.recorder && this.recorder.state === "recording") {
        this.recorder.stop();
      }
    };
  }
  
  

  private updateTimer() {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const secs = String(elapsed % 60).padStart(2, "0");
    this.timerEl.setText(`⏱️ ${mins}:${secs}`);
    if (this.recorder && this.recorder.state === "recording") {
      setTimeout(() => this.updateTimer(), 1000);
    }
  }

  private updateLevel() {
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((s, v) => s + (v - 128) ** 2, 0) / data.length);
    const percent = Math.min(100, (rms / 50) * 100);
    (this.levelEl as HTMLElement).style.width = `${percent}%`;
    if (this.recorder && this.recorder.state === "recording") {
      this.rafId = requestAnimationFrame(() => this.updateLevel());
    }
  }
  

  onClose() {
    this.onFinish(null);
    if (this.audioCtx) this.audioCtx.close();
    cancelAnimationFrame(this.rafId);
  }
}

/** -------------------- Audio file selector -------------------- */
class AudioFileSuggestModal extends SuggestModal<TFile> {
  private files: TFile[];
  private resolver!: (file: TFile | null) => void;

  constructor(app: App, files: TFile[]) {
    super(app);
    this.files = files;
    this.setPlaceholder("Select an audio file…");
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
  plugin: WhisperLocalServerPlugin;

  constructor(app: App, plugin: WhisperLocalServerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Whisper (Local Server)" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Example: http://127.0.0.1:5000")
      .addText(t => t
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async v => { this.plugin.settings.serverUrl = v.trim(); await this.plugin.saveData(this.plugin.settings); }));

    new Setting(containerEl)
      .setName("Language")
      .setDesc("auto, en, es…")
      .addText(t => t
        .setValue(this.plugin.settings.language)
        .onChange(async v => { this.plugin.settings.language = v.trim() || "auto"; await this.plugin.saveData(this.plugin.settings); }));

    new Setting(containerEl)
      .setName("Audio Folder")
      .setDesc("Where to store recordings and look for audio files")
      .addText(t => t
        .setValue(this.plugin.settings.audioFolder)
        .onChange(async v => { this.plugin.settings.audioFolder = v.trim() || "Audio"; await this.plugin.saveData(this.plugin.settings); }));

    new Setting(containerEl)
      .setName("Transcripts Folder")
      .setDesc("Where to store .md transcript files")
      .addText(t => t
        .setValue(this.plugin.settings.transcriptsFolder)
        .onChange(async v => { this.plugin.settings.transcriptsFolder = v.trim() || "Transcripts"; await this.plugin.saveData(this.plugin.settings); }));
  }
}
