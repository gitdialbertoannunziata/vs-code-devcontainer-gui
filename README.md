# Devcontainer GUI

Estensione per VS Code che aiuta a gestire i devcontainer basati su Docker
Compose: mostra la configurazione risolta (servizi, porte, variabili
d'ambiente, volumi) e permette di avviare, fermare, riavviare e vedere i log
dei singoli servizi senza uscire da VS Code o aprire Docker Desktop.

## Funzionalità

- **Configurazione risolta**: tree view nella sidebar con i file compose
  caricati e i servizi (evidenziando il *service* principale e quelli in
  `runServices`), ottenuta delegando il merge a `docker compose config`
  invece di reimplementarlo.
- **Stato dei servizi in tempo reale**: ogni servizio mostra se è in
  esecuzione, fermo o mai creato (`docker compose ps`).
- **Azioni rapide**: avvia, ferma, riavvia e vedi i log di un servizio
  direttamente dalla tree view.
- **Porte cliccabili**: le porte pubblicate aprono `http://localhost:<porta>`
  nel browser con un click.
- **Volumi bind apribili**: i mount di tipo bind si aprono in Esplora
  file/Finder con un click.
- **Variabili d'ambiente modificabili**: quelle definite letteralmente nel
  file compose o in un `env_file` referenziato si possono modificare dalla
  tree view; la scrittura preserva commenti e formattazione del file
  (libreria `yaml`, API Document). Le altre (ereditate dall'immagine, o da
  sostituzione `${VAR}` senza `env_file`) restano di sola lettura.
- **Funziona anche da dentro al devcontainer**: se la finestra è attaccata
  al container, l'estensione risolve automaticamente il percorso host reale
  (necessario perché gira sull'host, vedi sotto) chiedendo conferma quando
  ci sono più devcontainer attivi contemporaneamente.

## Requisiti

- Docker CLI con supporto a `docker compose` (v2) raggiungibile dall'host.
- Un `devcontainer.json` che usa `dockerComposeFile` — i devcontainer basati
  solo su `image`/`build` (senza compose) non sono nello scope di questa
  estensione.

## Limiti noti

- I devcontainer creati clonando il repository in un volume Docker gestito
  ("Clone Repository in Named Container Volume") non sono supportati: non
  esiste un percorso host da passare a `docker compose`, e la feature
  `docker-in-docker` (se presente) non basta perché usa un daemon isolato
  che non vede i container "fratelli" dello stesso devcontainer.
- Le variabili d'ambiente ereditate dall'immagine base, o risolte tramite
  sostituzione `${VAR}` nel compose senza un `env_file` esplicito, sono di
  sola lettura.

## Come provarla

Installa il pacchetto `.vsix`:

```
code --install-extension vs-code-devcontainer-gui-0.0.1.vsix
```

Poi apri una cartella progetto che contiene `.devcontainer/devcontainer.json`
con `dockerComposeFile` — l'icona "Devcontainer" comparirà nella activity
bar.

## Sviluppo

```
npm install
npm run compile   # oppure npm run watch
```

Premi **F5** in VS Code per aprire un Extension Development Host puntato su
`sample-workspace/`, un progetto di esempio con devcontainer + compose
incluso nel repository.

## Stato del progetto

Vedi [claude.md](claude.md) per l'elenco completo delle funzionalità
pianificate (MVP) e le decisioni tecniche.
