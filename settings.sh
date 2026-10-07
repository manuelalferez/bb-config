#!/usr/bin/env bash
# Ajustes de bb que no son ficheros: bb los guarda en su base de datos.
# Ejecutar en cada ordenador después de instalar bb: ./settings.sh
set -euo pipefail

# Atajos de teclado (ver los actuales: bb settings keyboard list)
bb settings keyboard set thread.next Mod+e --platform mac     # Cmd+E → siguiente hilo
bb settings keyboard set thread.archive Mod+g --platform mac  # Cmd+G → archivar hilo
