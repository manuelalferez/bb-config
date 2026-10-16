#!/usr/bin/env bash
# Ajustes de bb que no son ficheros: bb los guarda en su base de datos.
# Ejecutar en cada ordenador después de instalar bb: ./settings.sh
set -euo pipefail

# Plugins del marketplace de bb: se instalan si faltan (los de este repo, ver README)
for plugin in firstmate-crew; do
  bb plugin list --json | jq -e --arg id "$plugin" '.plugins[] | select(.id == $id)' > /dev/null \
    || bb plugin install "$plugin" --yes
done

# Codex apagado: su CLI no está instalado y FirstMate Crew arranca con el primer proveedor activo (Codex no tiene modelos)
bb provider disable codex   # volver a activarlo: bb provider enable codex

# FirstMate Crew: los crewmates usan Claude Code con Opus 5.5 y razonamiento alto
bb plugin config firstmate-crew set crewProvider claude-code
bb plugin config firstmate-crew set crewModel claude-opus-5-5
bb plugin config firstmate-crew set crewReasoning high

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
