# bb-config

Todo lo mío de bb, para tenerlo igual en el ordenador personal y en el del trabajo.

```
.bb/plugins.json   índice de los plugins del repo
plugins/<nombre>/  un plugin de bb por carpeta (su propio package.json)
skills/<nombre>/   skills de usuario (SKILL.md) → ~/.bb/skills
AGENTS.md          instrucciones globales (opcional) → ~/.bb/AGENTS.md
settings.sh        ajustes de bb (atajos de teclado…)
```

## Aplicar los ajustes

Atajos de teclado y demás ajustes viven en la base de datos de bb, no en ficheros.
`settings.sh` los vuelve a poner con la CLI:

```bash
./settings.sh
```

Al cambiar un ajuste en bb, añade su comando `bb settings …` al script.

## Instalar un plugin en otro ordenador

```bash
bb plugin install git:https://github.com/manuelalferez/bb-config@main --plugin claude-titles --yes
```

bb clona, instala dependencias y compila `dist/` solo. Sigue la rama `main`:

```bash
bb plugin outdated
bb plugin update claude-titles --yes
```

## Desarrollar en local

```bash
cd plugins/claude-titles && npm install
bb plugin install path:$PWD --yes   # una vez
bb plugin dev                       # recompila y recarga al guardar
```

## Añadir un plugin nuevo

1. `cd plugins && bb plugin new <nombre>`
2. Añadir `{ "name": "<nombre>", "source": "./plugins/<nombre>" }` a `.bb/plugins.json`.
3. Commit y push.
