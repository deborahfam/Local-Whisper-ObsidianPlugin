FROM python:3.10-slim

# Instalar dependencias del sistema necesarias para whisper/ffmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

# Exponer puerto
EXPOSE 5000

CMD ["python", "server.py"]
