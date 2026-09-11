import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parse as parseJsonc } from 'jsonc-parser';
import { Document, isMap, isSeq, isScalar, parseDocument } from 'yaml';

const execFileAsync = promisify(execFile);

export interface ResolvedPort {
	target: number;
	published?: string;
	protocol?: string;
}

export interface ResolvedVolume {
	type: string;
	source?: string;
	target: string;
	/** true se proviene da workspaceMount/mounts in devcontainer.json e non dal file compose. */
	fromDevcontainerJson?: boolean;
}

/** Dove scrivere per modificare una variabile: nel compose YAML stesso, o in un file .env referenziato via env_file. */
export type EnvVarSource =
	| { kind: 'compose'; filePath: string }
	| { kind: 'envFile'; filePath: string };

export interface ResolvedService {
	image?: string;
	environment: Record<string, string>;
	/** Per le variabili modificabili (definite letteralmente nel compose o in un env_file), dove scriverle. Le altre (ereditate dall'immagine, da .env di progetto) sono di sola lettura. */
	environmentSources: Record<string, EnvVarSource>;
	ports: ResolvedPort[];
	volumes: ResolvedVolume[];
	/** Stato riportato da `docker compose ps` (running, exited, paused, ...), assente se il container non è mai stato creato. */
	status?: string;
}

export interface DevcontainerConfig {
	devcontainerUri: vscode.Uri;
	composeFiles: string[];
	/** Cartella (host) da cui vanno invocati i comandi `docker compose`. */
	baseDir: string;
	/** Project name compose reale (es. "itrpricehub_devcontainer"): senza, `ps`/`start`/`stop` non trovano i container già creati dalla CLI Dev Containers. */
	projectName: string;
	mainService?: string;
	runServices: string[];
	services: Record<string, ResolvedService>;
	/** workspaceMount + mounts dichiarati in devcontainer.json, da mostrare sul service principale. */
	extraMounts: ResolvedVolume[];
}

export interface ContainerCandidate {
	containerId: string;
	name: string;
	localFolder: string;
	composeProjectName?: string;
}

/** Serve una conferma esplicita di quale container in esecuzione corrisponde a questa finestra. */
export class AmbiguousContainerError extends Error {
	constructor(public readonly candidates: ContainerCandidate[]) {
		super(`Conferma quale dei ${candidates.length} devcontainer in esecuzione sull'host è questa finestra.`);
	}
}

/**
 * Nessun container in esecuzione ha la label "devcontainer.local_folder":
 * quasi certamente questo devcontainer è stato creato clonando il
 * repository in un volume Docker ("Clone Repository in Named Container
 * Volume") invece che da una cartella locale — non esiste alcun percorso
 * host da passare a `docker compose`, quindi non è supportato per ora.
 */
export class UnsupportedWorkspaceError extends Error {
	constructor() {
		super(
			'Questo devcontainer non sembra montare una cartella locale (probabilmente è stato creato clonando il repository in un volume Docker): l\'estensione non supporta ancora questo scenario, perché non esiste un percorso host da usare con "docker compose".'
		);
	}
}

export async function findDevcontainerJson(): Promise<vscode.Uri | undefined> {
	const matches = await vscode.workspace.findFiles(
		'{**/.devcontainer/devcontainer.json,**/.devcontainer.json}',
		'**/node_modules/**',
		1
	);
	return matches[0];
}

/**
 * Carica devcontainer.json e risolve la configurazione compose delegando il
 * merge a `docker compose config` invece di reimplementarlo (vedi claude.md).
 *
 * `preferredContainerId` disambigua il caso in cui, stando dentro a un
 * devcontainer, sull'host ci sono più container con la label
 * "devcontainer.local_folder" (vedi AmbiguousContainerError).
 */
export async function loadDevcontainerConfig(devcontainerUri: vscode.Uri, preferredContainerId?: string): Promise<DevcontainerConfig> {
	const bytes = await vscode.workspace.fs.readFile(devcontainerUri);
	const text = Buffer.from(bytes).toString('utf8');
	const json = parseJsonc(text) ?? {};

	const rawComposeFiles: string | string[] | undefined = json.dockerComposeFile;
	if (!rawComposeFiles) {
		throw new Error('devcontainer.json non usa "dockerComposeFile": non è un devcontainer basato su compose.');
	}

	const { baseDir, localWorkspaceFolder, composeProjectName } = await resolveHostPaths(devcontainerUri, preferredContainerId);

	const composeFiles = (Array.isArray(rawComposeFiles) ? rawComposeFiles : [rawComposeFiles])
		.map(f => path.resolve(baseDir, f));

	const projectName = composeProjectName ?? await resolveComposeProjectName(localWorkspaceFolder);

	const [services, statuses] = await Promise.all([
		resolveComposeServices(composeFiles, baseDir, projectName),
		resolveServiceStatuses(composeFiles, baseDir, projectName)
	]);
	for (const [name, status] of Object.entries(statuses)) {
		if (services[name]) {
			services[name].status = status;
		}
	}

	const containerWorkspaceFolder = typeof json.workspaceFolder === 'string' ? json.workspaceFolder : undefined;
	const substitutionCtx = { localWorkspaceFolder, containerWorkspaceFolder };
	const extraMounts: ResolvedVolume[] = [];
	if (typeof json.workspaceMount === 'string') {
		const mount = normalizeMountEntry(json.workspaceMount, substitutionCtx);
		if (mount) {
			extraMounts.push(mount);
		}
	}
	if (Array.isArray(json.mounts)) {
		for (const entry of json.mounts) {
			const mount = normalizeMountEntry(entry, substitutionCtx);
			if (mount) {
				extraMounts.push(mount);
			}
		}
	}

	return {
		devcontainerUri,
		composeFiles,
		baseDir,
		projectName,
		mainService: typeof json.service === 'string' ? json.service : undefined,
		runServices: Array.isArray(json.runServices)
			? json.runServices
			: (typeof json.service === 'string' ? [json.service] : []),
		services,
		extraMounts
	};
}

export type ComposeLifecycleAction = 'start' | 'stop' | 'restart';

/** Avvia/ferma/riavvia un singolo servizio senza dover aprire Docker Desktop. */
export async function runComposeLifecycleAction(config: DevcontainerConfig, serviceName: string, action: ComposeLifecycleAction): Promise<void> {
	const composeArgs = action === 'start' ? ['up', '-d', serviceName] : [action, serviceName];
	const args = composeBaseArgs(config.composeFiles, config.projectName).concat(composeArgs);
	try {
		await execFileAsync('docker', ['compose', ...args], { cwd: config.baseDir, maxBuffer: 10 * 1024 * 1024 });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`"docker compose ${composeArgs.join(' ')}" fallito: ${message}`);
	}
}

export function composeBaseArgs(composeFiles: string[], projectName: string): string[] {
	return ['-p', projectName, ...composeFiles.flatMap(f => ['-f', f])];
}

/**
 * La CLI Dev Containers crea i container con un project name compose
 * proprio (di norma "<cartella-sanitizzata>_devcontainer"), diverso da
 * quello che `docker compose` dedurrebbe di default dalla cwd: senza,
 * `ps`/`start`/`stop` non troverebbero i container già esistenti.
 * Se un container per questo progetto è già in esecuzione, ne leggiamo il
 * project name reale dalla sua label compose; altrimenti usiamo la
 * convenzione della CLI come miglior tentativo.
 */
async function resolveComposeProjectName(localWorkspaceFolder: string): Promise<string> {
	try {
		const candidates = await listDevcontainerCandidates();
		const match = candidates.find(c => c.localFolder === localWorkspaceFolder && c.composeProjectName);
		if (match?.composeProjectName) {
			return match.composeProjectName;
		}
	} catch {
		// Docker non raggiungibile o nessun container: usiamo il fallback qui sotto.
	}
	return defaultComposeProjectName(localWorkspaceFolder);
}

function defaultComposeProjectName(localWorkspaceFolder: string): string {
	const sanitized = path.basename(localWorkspaceFolder).toLowerCase().replace(/[^a-z0-9_-]/g, '');
	return `${sanitized || 'devcontainer'}_devcontainer`;
}

/**
 * L'estensione gira sull'host (extensionKind: "ui") anche quando la finestra
 * è attaccata dentro al devcontainer: in quel caso `devcontainerUri.fsPath`
 * è un percorso *dentro* al container, non utilizzabile per invocare
 * `docker compose` sull'host. Se rileviamo quel contesto, risolviamo il
 * percorso host reale tramite la label `devcontainer.local_folder` che la
 * CLI Dev Containers assegna al container in esecuzione.
 */
async function resolveHostPaths(
	devcontainerUri: vscode.Uri,
	preferredContainerId: string | undefined
): Promise<{ baseDir: string; localWorkspaceFolder: string; composeProjectName?: string }> {
	const isAttached = vscode.env.remoteName === 'dev-container' || vscode.env.remoteName === 'attached-container';
	if (!isAttached) {
		const baseDir = path.dirname(devcontainerUri.fsPath);
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(devcontainerUri) ?? vscode.workspace.workspaceFolders?.[0];
		return { baseDir, localWorkspaceFolder: workspaceFolder?.uri.fsPath ?? baseDir };
	}

	const workspaceFolder = vscode.workspace.getWorkspaceFolder(devcontainerUri) ?? vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		throw new Error('Nessuna cartella di workspace aperta.');
	}
	const containerWorkspaceRoot = workspaceFolder.uri.fsPath;
	const containerDevcontainerDir = path.dirname(devcontainerUri.fsPath);

	const candidate = await findHostCandidate(preferredContainerId);
	const relativeToDevcontainerDir = path.relative(containerWorkspaceRoot, containerDevcontainerDir);
	const baseDir = path.join(candidate.localFolder, relativeToDevcontainerDir);
	return { baseDir, localWorkspaceFolder: candidate.localFolder, composeProjectName: candidate.composeProjectName };
}

/**
 * Elenca i container in esecuzione sull'host creati dalla CLI Dev Containers
 * (riconoscibili dalla label "devcontainer.local_folder").
 */
export async function listDevcontainerCandidates(): Promise<ContainerCandidate[]> {
	let runningIds: string[];
	try {
		runningIds = await listRunningContainerIds();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Impossibile contattare Docker dall'host: ${message}`);
	}

	const infos = await inspectContainers(runningIds);
	return infos
		.filter(info => typeof info?.Config?.Labels?.['devcontainer.local_folder'] === 'string')
		.map(info => ({
			containerId: info.Id as string,
			name: typeof info.Name === 'string' ? info.Name.replace(/^\//, '') : (info.Id as string),
			localFolder: info.Config.Labels['devcontainer.local_folder'] as string,
			composeProjectName: typeof info.Config.Labels['com.docker.compose.project'] === 'string'
				? (info.Config.Labels['com.docker.compose.project'] as string)
				: undefined
		}));
}

async function findHostCandidate(preferredContainerId: string | undefined): Promise<ContainerCandidate> {
	// L'API pubblica di VS Code non espone l'id del container a cui si è
	// attaccati (solo vscode.env.remoteName): anche con un solo container
	// candidato non possiamo essere certi che sia *questa* finestra (es. più
	// devcontainer con lo stesso workspaceFolder interno, aperti insieme).
	// Chiediamo quindi sempre conferma la prima volta per workspace, salvo
	// una preferenza già salvata e ancora valida.
	const candidates = await listDevcontainerCandidates();

	if (preferredContainerId) {
		const preferred = candidates.find(c => c.containerId === preferredContainerId || c.containerId.startsWith(preferredContainerId));
		if (preferred) {
			return preferred;
		}
	}

	if (candidates.length === 0) {
		throw new UnsupportedWorkspaceError();
	}
	throw new AmbiguousContainerError(candidates);
}

async function listRunningContainerIds(): Promise<string[]> {
	const { stdout } = await execFileAsync('docker', ['ps', '--format', '{{.ID}}']);
	return stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

async function inspectContainers(ids: string[]): Promise<any[]> {
	if (ids.length === 0) {
		return [];
	}
	const { stdout } = await execFileAsync('docker', ['inspect', ...ids]);
	return JSON.parse(stdout);
}

interface SubstitutionContext {
	localWorkspaceFolder: string;
	containerWorkspaceFolder?: string;
}

function substituteVariables(value: string, ctx: SubstitutionContext): string {
	return value
		.replace(/\$\{localWorkspaceFolder\}/g, ctx.localWorkspaceFolder)
		.replace(/\$\{localWorkspaceFolderBasename\}/g, path.basename(ctx.localWorkspaceFolder))
		.replace(/\$\{containerWorkspaceFolder\}/g, ctx.containerWorkspaceFolder ?? '')
		.replace(/\$\{containerWorkspaceFolderBasename\}/g, ctx.containerWorkspaceFolder ? path.basename(ctx.containerWorkspaceFolder) : '')
		.replace(/\$\{localEnv:([^}]+)\}/g, (_, name) => process.env[name] ?? '');
}

/** Formato raw dei mount devcontainer: "type=bind,source=...,target=...,consistency=cached". */
function parseMountString(raw: string): ResolvedVolume | undefined {
	const entries: Record<string, string> = {};
	for (const part of raw.split(',').map(p => p.trim()).filter(Boolean)) {
		const idx = part.indexOf('=');
		if (idx === -1) {
			continue;
		}
		entries[part.slice(0, idx)] = part.slice(idx + 1);
	}
	if (!entries.target) {
		return undefined;
	}
	return { type: entries.type ?? 'bind', source: entries.source, target: entries.target, fromDevcontainerJson: true };
}

function normalizeMountEntry(entry: unknown, ctx: SubstitutionContext): ResolvedVolume | undefined {
	if (typeof entry === 'string') {
		return parseMountString(substituteVariables(entry, ctx));
	}
	if (entry && typeof entry === 'object') {
		const e = entry as Record<string, unknown>;
		if (typeof e.target !== 'string') {
			return undefined;
		}
		return {
			type: typeof e.type === 'string' ? e.type : 'bind',
			source: typeof e.source === 'string' ? substituteVariables(e.source, ctx) : undefined,
			target: substituteVariables(e.target, ctx),
			fromDevcontainerJson: true
		};
	}
	return undefined;
}

async function resolveComposeServices(composeFiles: string[], cwd: string, projectName: string): Promise<Record<string, ResolvedService>> {
	const args = composeBaseArgs(composeFiles, projectName).concat(['config', '--format', 'json']);

	let stdout: string;
	try {
		({ stdout } = await execFileAsync('docker', ['compose', ...args], { cwd, maxBuffer: 10 * 1024 * 1024 }));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`"docker compose config" fallito: ${message}`);
	}

	const raw = JSON.parse(stdout);
	const envSources = await computeEnvVarSources(composeFiles);
	const services: Record<string, ResolvedService> = {};
	for (const [name, svc] of Object.entries<any>(raw.services ?? {})) {
		services[name] = {
			image: svc.image,
			environment: normalizeEnvironment(svc.environment),
			environmentSources: Object.fromEntries(envSources.get(name) ?? []),
			ports: (svc.ports ?? []).map((p: any) => ({ target: p.target, published: p.published, protocol: p.protocol })),
			volumes: (svc.volumes ?? []).map((v: any) => ({ type: v.type, source: v.source, target: v.target }))
		};
	}
	return services;
}

function scalarString(node: unknown): string | undefined {
	if (isScalar(node) && typeof node.value === 'string') {
		return node.value;
	}
	return undefined;
}

/**
 * Legge i file compose "grezzi" (non risolti) per capire quali variabili
 * sono modificabili in modo affidabile: quelle definite letteralmente in
 * "environment:" (mappa o forma "KEY=VALUE") hanno precedenza; per le
 * restanti, se il servizio referenzia un "env_file:", controlliamo lì.
 * Quelle ereditate dall'immagine o da un .env di progetto (variabili
 * `${VAR}` nel compose) restano di sola lettura.
 */
async function computeEnvVarSources(composeFiles: string[]): Promise<Map<string, Map<string, EnvVarSource>>> {
	const result = new Map<string, Map<string, EnvVarSource>>();

	for (const filePath of composeFiles) {
		const doc = await tryReadYamlDocument(filePath);
		const servicesNode = doc?.get('services', true);
		if (!isMap(servicesNode)) {
			continue;
		}
		for (const servicePair of servicesNode.items) {
			const serviceName = scalarString(servicePair.key);
			if (!serviceName || !isMap(servicePair.value)) {
				continue;
			}
			const sources = result.get(serviceName) ?? new Map<string, EnvVarSource>();

			const envNode = servicePair.value.get('environment', true);
			const literalKeys = new Set<string>();
			collectEnvKeys(envNode, literalKeys);
			for (const key of literalKeys) {
				sources.set(key, { kind: 'compose', filePath });
			}

			const envFilePaths = collectEnvFilePaths(servicePair.value.get('env_file', true), path.dirname(filePath));
			for (const envFilePath of envFilePaths) {
				for (const key of await readEnvFileKeys(envFilePath)) {
					if (!sources.has(key)) {
						sources.set(key, { kind: 'envFile', filePath: envFilePath });
					}
				}
			}

			if (sources.size > 0) {
				result.set(serviceName, sources);
			}
		}
	}
	return result;
}

function collectEnvKeys(envNode: unknown, keys: Set<string>): void {
	if (isMap(envNode)) {
		for (const pair of envNode.items) {
			const key = scalarString(pair.key);
			if (key) {
				keys.add(key);
			}
		}
	} else if (isSeq(envNode)) {
		for (const item of envNode.items) {
			const raw = scalarString(item);
			if (raw) {
				const eq = raw.indexOf('=');
				keys.add(eq === -1 ? raw : raw.slice(0, eq));
			}
		}
	}
}

/** "env_file:" può essere una stringa, una lista di stringhe, o (compose v2) una lista di {path, required}. */
function collectEnvFilePaths(envFileNode: unknown, composeFileDir: string): string[] {
	const rawPaths: string[] = [];
	if (isScalar(envFileNode) && typeof envFileNode.value === 'string') {
		rawPaths.push(envFileNode.value);
	} else if (isSeq(envFileNode)) {
		for (const item of envFileNode.items) {
			const raw = scalarString(item);
			if (raw) {
				rawPaths.push(raw);
				continue;
			}
			if (isMap(item)) {
				const p = scalarString(item.get('path', true));
				if (p) {
					rawPaths.push(p);
				}
			}
		}
	}
	return rawPaths.map(p => path.resolve(composeFileDir, p));
}

async function readEnvFileKeys(filePath: string): Promise<string[]> {
	try {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
		const text = Buffer.from(bytes).toString('utf8');
		const keys: string[] = [];
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) {
				continue;
			}
			const eq = trimmed.indexOf('=');
			if (eq === -1) {
				continue;
			}
			keys.push(trimmed.slice(0, eq).trim());
		}
		return keys;
	} catch {
		return [];
	}
}

async function tryReadYamlDocument(filePath: string): Promise<Document.Parsed | undefined> {
	try {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
		return parseDocument(Buffer.from(bytes).toString('utf8'));
	} catch {
		return undefined;
	}
}

/**
 * Scrive una variabile d'ambiente nella sua sorgente reale: il file compose
 * (preservando commenti/formattazione via l'API Document di `yaml`, vedi
 * claude.md) o il file .env referenziato via env_file.
 */
export async function setEnvironmentVariable(source: EnvVarSource, serviceName: string, key: string, value: string): Promise<void> {
	if (source.kind === 'envFile') {
		const uri = vscode.Uri.file(source.filePath);
		const bytes = await vscode.workspace.fs.readFile(uri);
		const text = Buffer.from(bytes).toString('utf8');
		const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');
		if (!pattern.test(text)) {
			throw new Error(`Variabile "${key}" non trovata in ${source.filePath}.`);
		}
		await vscode.workspace.fs.writeFile(uri, Buffer.from(text.replace(pattern, `${key}=${value}`), 'utf8'));
		return;
	}

	const doc = await tryReadYamlDocument(source.filePath);
	if (!doc) {
		throw new Error(`Impossibile leggere ${source.filePath}.`);
	}
	const envNode = doc.getIn(['services', serviceName, 'environment'], true);
	if (isMap(envNode) && envNode.has(key)) {
		doc.setIn(['services', serviceName, 'environment', key], value);
		await vscode.workspace.fs.writeFile(vscode.Uri.file(source.filePath), Buffer.from(doc.toString(), 'utf8'));
		return;
	}
	if (isSeq(envNode)) {
		const idx = envNode.items.findIndex(item => {
			const raw = scalarString(item);
			return raw !== undefined && (raw === key || raw.startsWith(`${key}=`));
		});
		if (idx !== -1) {
			envNode.set(idx, `${key}=${value}`);
			await vscode.workspace.fs.writeFile(vscode.Uri.file(source.filePath), Buffer.from(doc.toString(), 'utf8'));
			return;
		}
	}
	throw new Error(`Impossibile trovare "${key}" per il servizio "${serviceName}" in ${source.filePath}.`);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Stato attuale dei container per servizio (running/exited/paused/...); assenti = mai creati. */
async function resolveServiceStatuses(composeFiles: string[], cwd: string, projectName: string): Promise<Record<string, string>> {
	const args = composeBaseArgs(composeFiles, projectName).concat(['ps', '-a', '--format', 'json']);

	let stdout: string;
	try {
		({ stdout } = await execFileAsync('docker', ['compose', ...args], { cwd, maxBuffer: 10 * 1024 * 1024 }));
	} catch {
		// Non blocchiamo la tree view solo perché lo stato non è disponibile.
		return {};
	}

	const statuses: Record<string, string> = {};
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const entry = JSON.parse(trimmed);
			if (typeof entry.Service === 'string' && typeof entry.State === 'string') {
				statuses[entry.Service] = entry.State;
			}
		} catch {
			// riga non valida, ignorata
		}
	}
	return statuses;
}

function normalizeEnvironment(env: unknown): Record<string, string> {
	if (!env) {
		return {};
	}
	if (Array.isArray(env)) {
		const result: Record<string, string> = {};
		for (const entry of env) {
			const [key, ...rest] = String(entry).split('=');
			result[key] = rest.join('=');
		}
		return result;
	}
	return env as Record<string, string>;
}
