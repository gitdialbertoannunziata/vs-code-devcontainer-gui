import * as vscode from 'vscode';
import {
	AmbiguousContainerError,
	ContainerCandidate,
	DevcontainerConfig,
	EnvVarSource,
	ResolvedPort,
	ResolvedService,
	ResolvedVolume,
	UnsupportedWorkspaceError,
	findDevcontainerJson,
	loadDevcontainerConfig
} from './devcontainerConfig';

export const PREFERRED_CONTAINER_STATE_KEY = 'devcontainerGui.preferredContainerId';

export type TreeNode =
	| { kind: 'message'; label: string; description?: string; commandId?: string; commandArgs?: unknown[] }
	| { kind: 'composeFilesGroup'; files: string[] }
	| { kind: 'composeFile'; filePath: string }
	| { kind: 'servicesGroup'; config: DevcontainerConfig }
	| { kind: 'service'; name: string; service: ResolvedService; config: DevcontainerConfig; isMain: boolean; inRunServices: boolean; extraVolumes: ResolvedVolume[] }
	| { kind: 'detailGroup'; title: string; children: TreeNode[] }
	| { kind: 'detailItem'; text: string }
	| { kind: 'portItem'; text: string; url?: string }
	| { kind: 'envItem'; key: string; value: string; source?: EnvVarSource; serviceName: string; isMainService: boolean }
	| { kind: 'volumeItem'; text: string; hostPath?: string };

export function isEnvItemNode(node: unknown): node is Extract<TreeNode, { kind: 'envItem' }> {
	return !!node && typeof node === 'object' && (node as TreeNode).kind === 'envItem';
}

export function isServiceNode(node: unknown): node is Extract<TreeNode, { kind: 'service' }> {
	return !!node && typeof node === 'object' && (node as TreeNode).kind === 'service';
}

export class ConfigTreeProvider implements vscode.TreeDataProvider<TreeNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly context: vscode.ExtensionContext) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		switch (element.kind) {
			case 'message': {
				const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
				item.description = element.description;
				item.tooltip = element.description ? `${element.label}\n\n${element.description}` : element.label;
				item.iconPath = new vscode.ThemeIcon('info');
				if (element.commandId) {
					item.command = { command: element.commandId, title: element.label, arguments: element.commandArgs };
				}
				return item;
			}
			case 'composeFilesGroup': {
				const item = new vscode.TreeItem(
					`File compose (${element.files.length})`,
					vscode.TreeItemCollapsibleState.Expanded
				);
				item.iconPath = new vscode.ThemeIcon('files');
				return item;
			}
			case 'composeFile': {
				const uri = vscode.Uri.file(element.filePath);
				const item = new vscode.TreeItem(vscode.workspace.asRelativePath(uri), vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('file');
				item.resourceUri = uri;
				item.command = { command: 'vscode.open', title: 'Apri', arguments: [uri] };
				return item;
			}
			case 'servicesGroup': {
				const count = Object.keys(element.config.services).length;
				const item = new vscode.TreeItem(`Servizi (${count})`, vscode.TreeItemCollapsibleState.Expanded);
				item.iconPath = new vscode.ThemeIcon('layers');
				return item;
			}
			case 'service': {
				const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
				item.description = `${describeServiceRole(element.isMain, element.inRunServices)} · ${describeStatus(element.service.status)}`;
				item.tooltip = element.service.image;
				item.iconPath = statusIcon(element.service.status);
				item.contextValue = 'devcontainerGuiService';
				return item;
			}
			case 'detailGroup': {
				const item = new vscode.TreeItem(
					`${element.title} (${element.children.length})`,
					vscode.TreeItemCollapsibleState.Collapsed
				);
				item.iconPath = new vscode.ThemeIcon(iconForDetailGroup(element.title));
				return item;
			}
			case 'detailItem': {
				const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
				return item;
			}
			case 'portItem': {
				const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
				if (element.url) {
					item.iconPath = new vscode.ThemeIcon('link-external');
					item.tooltip = `Apri ${element.url}`;
					item.command = { command: 'vscode.open', title: 'Apri nel browser', arguments: [vscode.Uri.parse(element.url)] };
				}
				return item;
			}
			case 'envItem': {
				const item = new vscode.TreeItem(`${element.key}=${element.value}`, vscode.TreeItemCollapsibleState.None);
				if (element.source) {
					item.iconPath = new vscode.ThemeIcon('edit');
					item.tooltip = element.source.kind === 'envFile'
						? `Definita in ${element.source.filePath}. Clicca per modificare (serve un rebuild del devcontainer perché il cambiamento abbia effetto).`
						: 'Clicca per modificare (serve ricreare il container perché il cambiamento abbia effetto).';
					item.command = { command: 'devcontainerGui.editEnvVar', title: 'Modifica', arguments: [element] };
				} else {
					item.description = 'sola lettura';
					item.tooltip = 'Non definita direttamente nel file compose o in un env_file referenziato: non modificabile da qui.';
				}
				return item;
			}
			case 'volumeItem': {
				const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
				if (element.hostPath) {
					item.iconPath = new vscode.ThemeIcon('folder-opened');
					item.tooltip = `Apri ${element.hostPath} in Esplora file`;
					item.command = { command: 'revealFileInOS', title: 'Apri in Esplora file', arguments: [vscode.Uri.file(element.hostPath)] };
				}
				return item;
			}
		}
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!element) {
			return this.getRootChildren();
		}

		switch (element.kind) {
			case 'composeFilesGroup':
				return element.files.map((filePath): TreeNode => ({ kind: 'composeFile', filePath }));
			case 'servicesGroup':
				return this.getServiceNodes(element.config);
			case 'service':
				return this.getServiceDetailNodes(element.name, element.service, element.isMain, element.extraVolumes);
			case 'detailGroup':
				return element.children;
			default:
				return [];
		}
	}

	async selectPreferredContainer(candidates: ContainerCandidate[]): Promise<void> {
		const picked = await vscode.window.showQuickPick(
			candidates.map(c => ({ label: c.name, description: c.localFolder, containerId: c.containerId })),
			{ placeHolder: 'A quale devcontainer è collegata questa finestra?' }
		);
		if (picked) {
			await this.context.workspaceState.update(PREFERRED_CONTAINER_STATE_KEY, picked.containerId);
			this.refresh();
		}
	}

	private async getRootChildren(): Promise<TreeNode[]> {
		const devcontainerUri = await findDevcontainerJson();
		if (!devcontainerUri) {
			return [{ kind: 'message', label: 'Nessun devcontainer.json trovato nel workspace' }];
		}

		const preferredContainerId = this.context.workspaceState.get<string>(PREFERRED_CONTAINER_STATE_KEY);

		try {
			const config = await loadDevcontainerConfig(devcontainerUri, preferredContainerId);
			return [
				{ kind: 'composeFilesGroup', files: config.composeFiles },
				{ kind: 'servicesGroup', config }
			];
		} catch (err) {
			if (err instanceof AmbiguousContainerError) {
				return [{
					kind: 'message',
					label: 'Conferma a quale devcontainer è collegata questa finestra',
					description: err.candidates.map(c => c.name).join(', '),
					commandId: 'devcontainerGui.selectContainer',
					commandArgs: [err.candidates]
				}];
			}
			if (err instanceof UnsupportedWorkspaceError) {
				return [{ kind: 'message', label: 'Scenario non supportato', description: err.message }];
			}
			const message = err instanceof Error ? err.message : String(err);
			return [{ kind: 'message', label: 'Impossibile risolvere la configurazione', description: message }];
		}
	}

	private getServiceNodes(config: DevcontainerConfig): TreeNode[] {
		return Object.entries(config.services).map(([name, service]): TreeNode => {
			const isMain = name === config.mainService;
			return {
				kind: 'service',
				name,
				service,
				config,
				isMain,
				inRunServices: config.runServices.includes(name),
				extraVolumes: isMain ? config.extraMounts : []
			};
		});
	}

	private getServiceDetailNodes(serviceName: string, service: ResolvedService, isMain: boolean, extraVolumes: ResolvedVolume[]): TreeNode[] {
		const ports: TreeNode[] = service.ports.map(portNode);
		const env: TreeNode[] = Object.entries(service.environment).map(([key, value]): TreeNode => ({
			kind: 'envItem',
			key,
			value,
			source: service.environmentSources[key],
			serviceName,
			isMainService: isMain
		}));
		const volumes: TreeNode[] = [...service.volumes, ...extraVolumes].map(volumeNode);

		return [
			toDetailGroupNode('Porte', ports, 'Nessuna porta esposta'),
			toDetailGroupNode('Variabili d\'ambiente', env, 'Nessuna variabile definita'),
			toDetailGroupNode('Volumi', volumes, 'Nessun volume montato')
		];
	}
}

function portNode(p: ResolvedPort): TreeNode {
	const text = `${p.published ?? '-'} → ${p.target}/${p.protocol ?? 'tcp'}`;
	const url = p.published ? `http://localhost:${p.published}` : undefined;
	return { kind: 'portItem', text, url };
}

function formatVolume(v: ResolvedVolume): string {
	const base = `${v.source ?? '(anonimo)'} → ${v.target} (${v.type})`;
	return v.fromDevcontainerJson ? `${base} · da devcontainer.json` : base;
}

function volumeNode(v: ResolvedVolume): TreeNode {
	const text = formatVolume(v);
	const hostPath = v.type === 'bind' && v.source ? v.source : undefined;
	return { kind: 'volumeItem', text, hostPath };
}

function toDetailGroupNode(title: string, children: TreeNode[], emptyLabel: string): TreeNode {
	if (children.length === 0) {
		return { kind: 'message', label: `${title}: ${emptyLabel}` };
	}
	return { kind: 'detailGroup', title, children };
}

function describeServiceRole(isMain: boolean, inRunServices: boolean): string {
	if (isMain) {
		return 'service principale';
	}
	if (inRunServices) {
		return 'runServices';
	}
	return 'non in runServices';
}

function describeStatus(status: string | undefined): string {
	switch (status) {
		case 'running':
			return 'in esecuzione';
		case 'exited':
			return 'fermo';
		case 'paused':
			return 'in pausa';
		case 'restarting':
			return 'riavvio in corso';
		case 'dead':
			return 'dead';
		case undefined:
			return 'non creato';
		default:
			return status;
	}
}

function statusIcon(status: string | undefined): vscode.ThemeIcon {
	switch (status) {
		case 'running':
			return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
		case 'restarting':
			return new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.yellow'));
		case 'paused':
			return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.yellow'));
		case 'exited':
		case 'dead':
			return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));
		default:
			return new vscode.ThemeIcon('circle-outline');
	}
}

function iconForDetailGroup(title: string): string {
	switch (title) {
		case 'Porte':
			return 'plug';
		case 'Variabili d\'ambiente':
			return 'symbol-variable';
		case 'Volumi':
			return 'database';
		default:
			return 'circle-outline';
	}
}
