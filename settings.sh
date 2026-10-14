#!/usr/bin/env bash
# Ajustes de bb que no son ficheros: bb los guarda en su base de datos.
# Ejecutar en cada ordenador después de instalar bb: ./settings.sh
set -euo pipefail

# Atajos de teclado (ver los actuales: bb settings keyboard list)
bb settings keyboard set thread.next Mod+e --platform mac     # Cmd+E → siguiente hilo
bb settings keyboard set thread.archive Mod+g --platform mac  # Cmd+G → archivar hilo

# Batería de uso: mostrar solo la sesión de 5 horas (por defecto: el límite con menos margen)
bb plugin config usage-battery set mode session

# Artifacts en los hilos de Claude: bb lanza Claude Code en modo SDK, que oculta la herramienta Artifact.
# CLAUDE_CODE_ARTIFACT=1 (sin documentar) la activa. Va en ~/.claude/settings.json, así que vale para todo `claude`.
# Quitar: jq 'del(.env.CLAUDE_CODE_ARTIFACT)'
claude_settings="$HOME/.claude/settings.json"
mkdir -p "$(dirname "$claude_settings")"
[ -f "$claude_settings" ] || echo '{}' > "$claude_settings"
tmp="$(mktemp)"
jq '.env = ((.env // {}) + {"CLAUDE_CODE_ARTIFACT": "1"})' "$claude_settings" > "$tmp" && cat "$tmp" > "$claude_settings" && rm "$tmp"   # cat conserva los permisos
