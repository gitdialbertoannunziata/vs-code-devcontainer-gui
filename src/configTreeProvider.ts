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
					`Compose files (${element.files.length})`,
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
				item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
				return item;
			}
			case 'servicesGroup': {
				const count = Object.keys(element.config.services).length;
				const item = new vscode.TreeItem(`Services (${count})`, vscode.TreeItemCollapsibleState.Expanded);
				item.iconPath = new vscode.ThemeIcon('layers');
				return item;
			}
			case 'service': {
				const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
				item.description = `${element.service.image ?? 'unknown image'} · ${describeStatus(element.service.status)}`;
				item.tooltip = `${element.service.image ?? ''}\n${describeServiceRole(element.isMain, element.inRunServices)} · ${describeStatus(element.service.status)}`;
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
					item.tooltip = `Open ${element.url}`;
					item.command = { command: 'vscode.open', title: 'Open in browser', arguments: [vscode.Uri.parse(element.url)] };
				}
				return item;
			}
			case 'envItem': {
				const item = new vscode.TreeItem(`${element.key}=${element.value}`, vscode.TreeItemCollapsibleState.None);
				if (element.source) {
					item.iconPath = new vscode.ThemeIcon('edit');
					item.tooltip = element.source.kind === 'envFile'
						? `Defined in ${element.source.filePath}. Click to edit (the devcontainer needs a rebuild for the change to take effect).`
						: 'Click to edit (the container needs to be recreated for the change to take effect).';
					item.command = { command: 'devcontainerGui.editEnvVar', title: 'Edit', arguments: [element] };
				} else {
					item.description = 'read-only';
					item.tooltip = 'Not defined directly in the compose file or in a referenced env_file: cannot be edited from here.';
				}
				return item;
			}
			case 'volumeItem': {
				const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
				if (element.hostPath) {
					item.iconPath = new vscode.ThemeIcon('folder-opened');
					item.tooltip = `Reveal ${element.hostPath} in file explorer`;
					item.command = { command: 'revealFileInOS', title: 'Reveal in File Explorer', arguments: [vscode.Uri.file(element.hostPath)] };
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
			{ placeHolder: 'Which devcontainer is this window attached to?' }
		);
		if (picked) {
			await this.context.workspaceState.update(PREFERRED_CONTAINER_STATE_KEY, picked.containerId);
			this.refresh();
		}
	}

	private async getRootChildren(): Promise<TreeNode[]> {
		const devcontainerUri = await findDevcontainerJson();
		if (!devcontainerUri) {
			return [{ kind: 'message', label: 'No devcontainer.json found in the workspace' }];
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
					label: 'Confirm which devcontainer this window is attached to',
					description: err.candidates.map(c => c.name).join(', '),
					commandId: 'devcontainerGui.selectContainer',
					commandArgs: [err.candidates]
				}];
			}
			if (err instanceof UnsupportedWorkspaceError) {
				return [{ kind: 'message', label: 'Unsupported scenario', description: err.message }];
			}
			const message = err instanceof Error ? err.message : String(err);
			return [{ kind: 'message', label: 'Unable to resolve the configuration', description: message }];
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
			toDetailGroupNode('Ports', ports, 'No exposed ports'),
			toDetailGroupNode('Environment variables', env, 'No variables defined'),
			toDetailGroupNode('Volumes', volumes, 'No volumes mounted')
		];
	}
}

function portNode(p: ResolvedPort): TreeNode {
	const text = `${p.published ?? '-'} → ${p.target}/${p.protocol ?? 'tcp'}`;
	const url = p.published ? `http://localhost:${p.published}` : undefined;
	return { kind: 'portItem', text, url };
}

function formatVolume(v: ResolvedVolume): string {
	const base = `${v.source ?? '(anonymous)'} → ${v.target} (${v.type})`;
	return v.fromDevcontainerJson ? `${base} · from devcontainer.json` : base;
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
		return 'main service';
	}
	if (inRunServices) {
		return 'runServices';
	}
	return 'not in runServices';
}

function describeStatus(status: string | undefined): string {
	switch (status) {
		case 'running':
			return 'running';
		case 'exited':
			return 'stopped';
		case 'paused':
			return 'paused';
		case 'restarting':
			return 'restarting';
		case 'dead':
			return 'dead';
		case undefined:
			return 'not created';
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
		case 'Ports':
			return 'plug';
		case 'Environment variables':
			return 'symbol-variable';
		case 'Volumes':
			return 'database';
		default:
			return 'circle-outline';
	}
}
