#!/bin/bash
set -e

# Nombre del entorno virtual
VENV=".venv"

# Crear venv si no existe
if [ ! -d "$VENV" ]; then
    echo "🔧 Creando entorno virtual..."
    python3 -m venv $VENV
fi

# Activar venv
source $VENV/bin/activate

# Instalar dependencias
echo "📦 Instalando dependencias..."
pip install --upgrade pip
pip install -r requirements.txt

# Levantar servidor
echo "🚀 Levantando servidor Flask con Whisper..."
python server.py
