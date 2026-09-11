# vs-code-devcontainer-gui

## Obiettivo
Estensione per VS Code che migliora l'esperienza con i devcontainer basati su
Docker Compose, offrendo un modo semplice per gestire le impostazioni. Copre sia
il `devcontainer.json` (proprietà, `customizations.vscode.settings`, estensioni)
sia la configurazione dei servizi nei file compose.

## Problemi da risolvere
- La configurazione è sparsa tra `devcontainer.json`, uno o più file compose,
  `.env` e override: manca una vista d'insieme.
- Non è chiaro dove mettere env, porte e volumi (compose o devcontainer.json).
- In modalità compose alcune proprietà vengono ignorate senza errori evidenti:
  `runArgs`, `appPort`, `build`, `workspaceMount`.
- Non si capisce quali modifiche richiedano "Rebuild" e quali basti "Reopen".
- Difficile separare le impostazioni personali da quelle condivise col team.

## MVP (in ordine di sviluppo)
1. Scaffolding del progetto TypeScript con manifest e comando di attivazione.
2. Tree view nella sidebar con la configurazione risolta: file compose caricati,
   servizi (evidenziando `service` principale e `runServices`), porte, env, volumi.
3. Linting compose-aware come Diagnostics: `service` inesistente nei compose,
   proprietà ignorate in modalità compose, `workspaceFolder` non coperto da
   nessun volume.
4. Azioni rapide: toggle servizio in `runServices`, aggiunta porta/variabile
   scegliendo esplicitamente la destinazione (compose o devcontainer.json),
   indicatore "rebuild necessario" basato sul diff dall'ultima build.
5. Editor a form (webview) per le proprietà più usate.
6. (Poi) File compose locale non versionato per le personalizzazioni personali,
   creato automaticamente se manca, così l'apertura non fallisce per chi non ce l'ha.

## Decisioni tecniche
- Linguaggio: TypeScript. Scaffolding con `yo code` o equivalente manuale.
- `devcontainer.json`: usare `jsonc-parser` (`modify` + `applyEdits`) per
  modifiche chirurgiche che preservano commenti e formattazione.
- File compose: usare la libreria `yaml` (eemeli) con la Document API per
  preservare i commenti.
- Configurazione risolta: non reimplementare il merge, usare
  `docker compose -f <file...> config --format json`.
- `"extensionKind": ["ui"]`: l'estensione gira sull'host, dove il CLI Docker è
  disponibile anche quando la finestra è dentro al container.
- Accesso ai file sempre tramite `vscode.workspace.fs` (funziona con workspace remoti).
- Rilevare il contesto con `vscode.env.remoteName === 'dev-container'`.
- `publisher` nel package.json: segnaposto finché non c'è un publisher ID.

## Primo passo
Creare lo scaffolding, implementare la tree view della configurazione risolta
su un progetto di esempio con devcontainer + compose, e verificare con F5
nell'Extension Development Host.