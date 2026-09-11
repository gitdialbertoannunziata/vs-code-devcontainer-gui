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
	/** true if it comes from workspaceMount/mounts in devcontainer.json rather than the compose file. */
	fromDevcontainerJson?: boolean;
}

/** Where to write to edit a variable: the compose YAML itself, or a .env file referenced via env_file. */
export type EnvVarSource =
	| { kind: 'compose'; filePath: string }
	| { kind: 'envFile'; filePath: string };

export interface ResolvedService {
	image?: string;
	environment: Record<string, string>;
	/** For editable variables (defined literally in compose or in an env_file), where to write them. Others (inherited from the image, from a project .env) are read-only. */
	environmentSources: Record<string, EnvVarSource>;
	ports: ResolvedPort[];
	volumes: ResolvedVolume[];
	/** Status reported by `docker compose ps` (running, exited, paused, ...), absent if the container was never created. */
	status?: string;
}

export interface DevcontainerConfig {
	devcontainerUri: vscode.Uri;
	composeFiles: string[];
	/** Host folder to invoke `docker compose` commands from. */
	baseDir: string;
	/** Real compose project name (e.g. "itrpricehub_devcontainer"): without it, `ps`/`start`/`stop` won't find containers already created by the Dev Containers CLI. */
	projectName: string;
	mainService?: string;
	runServices: string[];
	services: Record<string, ResolvedService>;
	/** workspaceMount + mounts declared in devcontainer.json, shown on the main service. */
	extraMounts: ResolvedVolume[];
}

export interface ContainerCandidate {
	containerId: string;
	name: string;
	localFolder: string;
	composeProjectName?: string;
}

/** An explicit confirmation is needed for which running container corresponds to this window. */
export class AmbiguousContainerError extends Error {
	constructor(public readonly candidates: ContainerCandidate[]) {
		super(`Confirm which of the ${candidates.length} running devcontainers is this window.`);
	}
}

/**
 * No running container has the "devcontainer.local_folder" label: this
 * devcontainer was almost certainly created by cloning the repository into
 * a Docker volume ("Clone Repository in Named Container Volume") instead of
 * from a local folder — there is no host path to pass to `docker compose`,
 * so this scenario isn't supported yet.
 */
export class UnsupportedWorkspaceError extends Error {
	constructor() {
		super(
			'This devcontainer doesn\'t seem to mount a local folder (it was probably created by cloning the repository into a Docker volume): the extension doesn\'t support this scenario yet, because there is no host path to use with "docker compose".'
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
 * Loads devcontainer.json and resolves the compose configuration by
 * delegating the merge to `docker compose config` instead of
 * reimplementing it (see claude.md).
 *
 * `preferredContainerId` disambiguates the case where, while inside a
 * devcontainer, the host has more than one container with the
 * "devcontainer.local_folder" label (see AmbiguousContainerError).
 */
export async function loadDevcontainerConfig(devcontainerUri: vscode.Uri, preferredContainerId?: string): Promise<DevcontainerConfig> {
	const bytes = await vscode.workspace.fs.readFile(devcontainerUri);
	const text = Buffer.from(bytes).toString('utf8');
	const json = parseJsonc(text) ?? {};

	const rawComposeFiles: string | string[] | undefined = json.dockerComposeFile;
	if (!rawComposeFiles) {
		throw new Error('devcontainer.json does not use "dockerComposeFile": this is not a compose-based devcontainer.');
	}

	const { baseDir, localWorkspaceFolder, composeProjectName } = await resolveHostPaths(devcontainerUri, preferredContainerId);

	const composeFiles = (Array.isArray(rawComposeFiles) ? rawComposeFiles : [rawComposeFiles])
		.map(f => path.resolve(baseDir, f));

	const projectName = composeProjectName ?? await resolveComposeProjectName(localWorkspaceFolder);

	const [services, statuses] = await Promise.all([
		resolveComposeServices(composeFiles, baseDir, projectName),
		resolveServiceStatuses(composeFiles, baseDir, projectName)
	]);
	for (const [name, info] of Object.entries(statuses)) {
		if (services[name]) {
			services[name].status = info.status;
			// `docker compose config` has no "image" for build-based services
			// (no image tag exists until it's actually built); fall back to
			// what the already-created container reports, if any.
			services[name].image ??= info.image;
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

/**
 * Resolves the real container ID for a service, so callers can run a plain
 * `docker exec -it <id> ...` directly (fewer quoting layers than routing an
 * already-quoted shell command back through `docker compose exec -p ... -f
 * ...`, which is what Docker Desktop's own "Open in terminal" does too).
 * Undefined if the service was never created or isn't running.
 */
export async function resolveContainerId(config: DevcontainerConfig, serviceName: string): Promise<string | undefined> {
	const args = composeBaseArgs(config.composeFiles, config.projectName).concat(['ps', '-a', '--format', 'json', serviceName]);
	let stdout: string;
	try {
		({ stdout } = await execFileAsync('docker', ['compose', ...args], { cwd: config.baseDir, maxBuffer: 10 * 1024 * 1024 }));
	} catch {
		return undefined;
	}
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const entry = JSON.parse(trimmed);
			if (typeof entry.ID === 'string' && entry.State === 'running') {
				return entry.ID;
			}
		} catch {
			// invalid line, ignored
		}
	}
	return undefined;
}

/**
 * Picks bash if available, falling back to /bin/sh (which every container
 * has) — resolved as a plain path with a separate, unquoted check, so the
 * command we eventually hand to an external terminal is exactly as simple
 * as Docker Desktop's own `docker exec -it <id> /bin/sh`: no `-c`, no `||`,
 * nothing for a shell (ours or the container's) to possibly misparse.
 */
export async function resolveShellPath(containerId: string): Promise<string> {
	try {
		await execFileAsync('docker', ['exec', containerId, 'test', '-x', '/bin/bash']);
		return '/bin/bash';
	} catch {
		return '/bin/sh';
	}
}

export type ComposeLifecycleAction = 'start' | 'stop' | 'restart';

/** Start/stop/restart a single service without having to open Docker Desktop. */
export async function runComposeLifecycleAction(config: DevcontainerConfig, serviceName: string, action: ComposeLifecycleAction): Promise<void> {
	const composeArgs = action === 'start' ? ['up', '-d', serviceName] : [action, serviceName];
	const args = composeBaseArgs(config.composeFiles, config.projectName).concat(composeArgs);
	try {
		await execFileAsync('docker', ['compose', ...args], { cwd: config.baseDir, maxBuffer: 10 * 1024 * 1024 });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`"docker compose ${composeArgs.join(' ')}" failed: ${message}`);
	}
}

export function composeBaseArgs(composeFiles: string[], projectName: string): string[] {
	return ['-p', projectName, ...composeFiles.flatMap(f => ['-f', f])];
}

/**
 * The Dev Containers CLI creates containers with its own compose project
 * name (normally "<sanitized-folder>_devcontainer"), different from what
 * `docker compose` would infer by default from the cwd: without it,
 * `ps`/`start`/`stop` wouldn't find containers that already exist.
 * If a container for this project is already running, we read its real
 * project name from its compose label; otherwise we fall back to the CLI's
 * naming convention as a best effort.
 */
async function resolveComposeProjectName(localWorkspaceFolder: string): Promise<string> {
	try {
		const candidates = await listDevcontainerCandidates();
		const match = candidates.find(c => c.localFolder === localWorkspaceFolder && c.composeProjectName);
		if (match?.composeProjectName) {
			return match.composeProjectName;
		}
	} catch {
		// Docker unreachable or no container running: fall back below.
	}
	return defaultComposeProjectName(localWorkspaceFolder);
}

function defaultComposeProjectName(localWorkspaceFolder: string): string {
	const sanitized = path.basename(localWorkspaceFolder).toLowerCase().replace(/[^a-z0-9_-]/g, '');
	return `${sanitized || 'devcontainer'}_devcontainer`;
}

/**
 * The extension runs on the host (extensionKind: "ui") even when the window
 * is attached inside the devcontainer: in that case `devcontainerUri.fsPath`
 * is a path *inside* the container, unusable for invoking `docker compose`
 * on the host. When we detect that context, we resolve the real host path
 * via the "devcontainer.local_folder" label the Dev Containers CLI assigns
 * to the running container.
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
		throw new Error('No workspace folder is open.');
	}
	const containerWorkspaceRoot = workspaceFolder.uri.fsPath;
	const containerDevcontainerDir = path.dirname(devcontainerUri.fsPath);

	const candidate = await findHostCandidate(preferredContainerId);
	const relativeToDevcontainerDir = path.relative(containerWorkspaceRoot, containerDevcontainerDir);
	const baseDir = path.join(candidate.localFolder, relativeToDevcontainerDir);
	return { baseDir, localWorkspaceFolder: candidate.localFolder, composeProjectName: candidate.composeProjectName };
}

/**
 * Lists containers running on the host that were created by the Dev
 * Containers CLI (recognizable from the "devcontainer.local_folder" label).
 */
export async function listDevcontainerCandidates(): Promise<ContainerCandidate[]> {
	let runningIds: string[];
	try {
		runningIds = await listRunningContainerIds();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Unable to reach Docker from the host: ${message}`);
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
	// VS Code's public API doesn't expose the id of the container we're
	// attached to (only vscode.env.remoteName): even with a single
	// candidate container we can't be sure it's *this* window (e.g.
	// multiple devcontainers sharing the same internal workspaceFolder,
	// running together). So we always ask for confirmation the first time
	// per workspace, unless a still-valid preference was already saved.
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

/** Raw devcontainer mount format: "type=bind,source=...,target=...,consistency=cached". */
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
		throw new Error(`"docker compose config" failed: ${message}`);
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
 * Reads the "raw" (unresolved) compose files to figure out which variables
 * can be reliably edited: those defined literally under "environment:"
 * (mapping or "KEY=VALUE" form) take precedence; for the rest, if the
 * service references an "env_file:", we check there. Variables inherited
 * from the image, or coming from a project .env via `${VAR}` substitution
 * in the compose file, remain read-only.
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

/** "env_file:" can be a string, a list of strings, or (compose v2) a list of {path, required}. */
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
 * Writes an environment variable to its real source: the compose file
 * (preserving comments/formatting via the `yaml` Document API, see
 * claude.md) or the .env file referenced via env_file.
 */
export async function setEnvironmentVariable(source: EnvVarSource, serviceName: string, key: string, value: string): Promise<void> {
	if (source.kind === 'envFile') {
		const uri = vscode.Uri.file(source.filePath);
		const bytes = await vscode.workspace.fs.readFile(uri);
		const text = Buffer.from(bytes).toString('utf8');
		const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');
		if (!pattern.test(text)) {
			throw new Error(`Variable "${key}" not found in ${source.filePath}.`);
		}
		await vscode.workspace.fs.writeFile(uri, Buffer.from(text.replace(pattern, `${key}=${value}`), 'utf8'));
		return;
	}

	const doc = await tryReadYamlDocument(source.filePath);
	if (!doc) {
		throw new Error(`Unable to read ${source.filePath}.`);
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
	throw new Error(`Unable to find "${key}" for service "${serviceName}" in ${source.filePath}.`);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ServiceRuntimeInfo {
	status: string;
	/** Real image tag as reported by the container, used as a fallback for build-based services (no "image" in `docker compose config`). */
	image?: string;
}

/** Current status (and, incidentally, real image tag) of containers per service; absent = never created. */
async function resolveServiceStatuses(composeFiles: string[], cwd: string, projectName: string): Promise<Record<string, ServiceRuntimeInfo>> {
	const args = composeBaseArgs(composeFiles, projectName).concat(['ps', '-a', '--format', 'json']);

	let stdout: string;
	try {
		({ stdout } = await execFileAsync('docker', ['compose', ...args], { cwd, maxBuffer: 10 * 1024 * 1024 }));
	} catch {
		// Don't block the tree view just because the status isn't available.
		return {};
	}

	const statuses: Record<string, ServiceRuntimeInfo> = {};
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const entry = JSON.parse(trimmed);
			if (typeof entry.Service === 'string' && typeof entry.State === 'string') {
				statuses[entry.Service] = {
					status: entry.State,
					image: typeof entry.Image === 'string' ? entry.Image : undefined
				};
			}
		} catch {
			// invalid line, ignored
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
