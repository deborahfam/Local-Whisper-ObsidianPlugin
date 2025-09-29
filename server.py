# server.py
from flask import Flask, request, jsonify
import base64
import tempfile
import os
import traceback
import torch

try:
    import whisper
except Exception as e:
    raise RuntimeError("Falta instalar whisper. Ejecuta: pip install openai-whisper") from e

app = Flask(__name__)

# Cargar el modelo una vez (puede tardar)
MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")  # puedes usar "small","medium","large" según tu GPU/CPU
print("Cargando modelo Whisper:", MODEL_NAME)
device = "cuda" if torch.cuda.is_available() else "cpu"
model = whisper.load_model(MODEL_NAME, device=device)
print("Modelo cargado.")

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "model": MODEL_NAME})

@app.route("/transcribe", methods=["POST"])
def transcribe():
    try:
        payload = request.get_json(force=True)
        if not payload:
            return jsonify({"ok": False, "error": "Request JSON vacío"}), 400

        data_b64 = payload.get("data")
        if not data_b64:
            return jsonify({"ok": False, "error": "Falta campo 'data' (base64)"}), 400

        filename = payload.get("filename", "audio")
        fmt = payload.get("format", "wav")
        language = payload.get("language", "auto")  # 'auto' para detección automática

        # Guardar archivo temporal
        suffix = f".{fmt}" if not filename.endswith(f".{fmt}") else ""
        tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        try:
            tmp.write(base64.b64decode(data_b64))
            tmp.flush()
            tmp.close()

            # Transcribir
            whisper_opts = {}
            if language and language != "auto":
                whisper_opts["language"] = language

            print(f"Transcribiendo {tmp.name} (lang={language})")
            result = model.transcribe(tmp.name, **whisper_opts)
            text = result.get("text", "").strip()
        finally:
            try:
                os.unlink(tmp.name)
            except Exception:
                pass

        return jsonify({"ok": True, "text": text})
    except Exception as e:
        tb = traceback.format_exc()
        print("ERROR en transcribe:", tb)
        return jsonify({"ok": False, "error": str(e), "trace": tb}), 500

if __name__ == "__main__":
    # Ejecuta con: python server.py
    # Exponer sólo en localhost por seguridad
    app.run(host="127.0.0.1", port=5000, debug=False)
