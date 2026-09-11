import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parse as parseJsonc } from 'jsonc-parser';

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
}

export interface ResolvedService {
	image?: string;
	environment: Record<string, string>;
	ports: ResolvedPort[];
	volumes: ResolvedVolume[];
}

export interface DevcontainerConfig {
	devcontainerUri: vscode.Uri;
	composeFiles: string[];
	mainService?: string;
	runServices: string[];
	services: Record<string, ResolvedService>;
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
 */
export async function loadDevcontainerConfig(devcontainerUri: vscode.Uri): Promise<DevcontainerConfig> {
	const bytes = await vscode.workspace.fs.readFile(devcontainerUri);
	const text = Buffer.from(bytes).toString('utf8');
	const json = parseJsonc(text) ?? {};

	const rawComposeFiles: string | string[] | undefined = json.dockerComposeFile;
	if (!rawComposeFiles) {
		throw new Error('devcontainer.json non usa "dockerComposeFile": non è un devcontainer basato su compose.');
	}

	const baseDir = path.dirname(devcontainerUri.fsPath);
	const composeFiles = (Array.isArray(rawComposeFiles) ? rawComposeFiles : [rawComposeFiles])
		.map(f => path.resolve(baseDir, f));

	const services = await resolveComposeServices(composeFiles, baseDir);

	return {
		devcontainerUri,
		composeFiles,
		mainService: typeof json.service === 'string' ? json.service : undefined,
		runServices: Array.isArray(json.runServices)
			? json.runServices
			: (typeof json.service === 'string' ? [json.service] : []),
		services
	};
}

async function resolveComposeServices(composeFiles: string[], cwd: string): Promise<Record<string, ResolvedService>> {
	const args = composeFiles.flatMap(f => ['-f', f]).concat(['config', '--format', 'json']);

	let stdout: string;
	try {
		({ stdout } = await execFileAsync('docker', ['compose', ...args], { cwd, maxBuffer: 10 * 1024 * 1024 }));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`"docker compose config" fallito: ${message}`);
	}

	const raw = JSON.parse(stdout);
	const services: Record<string, ResolvedService> = {};
	for (const [name, svc] of Object.entries<any>(raw.services ?? {})) {
		services[name] = {
			image: svc.image,
			environment: normalizeEnvironment(svc.environment),
			ports: (svc.ports ?? []).map((p: any) => ({ target: p.target, published: p.published, protocol: p.protocol })),
			volumes: (svc.volumes ?? []).map((v: any) => ({ type: v.type, source: v.source, target: v.target }))
		};
	}
	return services;
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
