import * as vscode from 'vscode';
import {
	DevcontainerConfig,
	ResolvedService,
	findDevcontainerJson,
	loadDevcontainerConfig
} from './devcontainerConfig';

type TreeNode =
	| { kind: 'message'; label: string; description?: string }
	| { kind: 'composeFilesGroup'; files: string[] }
	| { kind: 'composeFile'; filePath: string }
	| { kind: 'servicesGroup'; config: DevcontainerConfig }
	| { kind: 'service'; name: string; service: ResolvedService; isMain: boolean; inRunServices: boolean }
	| { kind: 'detailGroup'; title: string; items: string[] }
	| { kind: 'detailItem'; text: string };

export class ConfigTreeProvider implements vscode.TreeDataProvider<TreeNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		switch (element.kind) {
			case 'message': {
				const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
				item.description = element.description;
				item.iconPath = new vscode.ThemeIcon('info');
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
				item.description = describeServiceRole(element.isMain, element.inRunServices);
				item.tooltip = element.service.image;
				item.iconPath = new vscode.ThemeIcon(element.isMain ? 'star-full' : 'vm');
				return item;
			}
			case 'detailGroup': {
				const item = new vscode.TreeItem(
					`${element.title} (${element.items.length})`,
					vscode.TreeItemCollapsibleState.Collapsed
				);
				item.iconPath = new vscode.ThemeIcon(iconForDetailGroup(element.title));
				return item;
			}
			case 'detailItem': {
				const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
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
				return this.getServiceDetailNodes(element.service);
			case 'detailGroup':
				return element.items.map((text): TreeNode => ({ kind: 'detailItem', text }));
			default:
				return [];
		}
	}

	private async getRootChildren(): Promise<TreeNode[]> {
		const devcontainerUri = await findDevcontainerJson();
		if (!devcontainerUri) {
			return [{ kind: 'message', label: 'Nessun devcontainer.json trovato nel workspace' }];
		}

		try {
			const config = await loadDevcontainerConfig(devcontainerUri);
			return [
				{ kind: 'composeFilesGroup', files: config.composeFiles },
				{ kind: 'servicesGroup', config }
			];
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return [{ kind: 'message', label: 'Impossibile risolvere la configurazione', description: message }];
		}
	}

	private getServiceNodes(config: DevcontainerConfig): TreeNode[] {
		return Object.entries(config.services).map(([name, service]): TreeNode => ({
			kind: 'service',
			name,
			service,
			isMain: name === config.mainService,
			inRunServices: config.runServices.includes(name)
		}));
	}

	private getServiceDetailNodes(service: ResolvedService): TreeNode[] {
		const ports = service.ports.map(p => `${p.published ?? '-'} → ${p.target}/${p.protocol ?? 'tcp'}`);
		const env = Object.entries(service.environment).map(([key, value]) => `${key}=${value}`);
		const volumes = service.volumes.map(v => `${v.source ?? '(anonimo)'} → ${v.target} (${v.type})`);

		const groups: TreeNode[] = [];
		groups.push(toDetailNode('Porte', ports, 'Nessuna porta esposta'));
		groups.push(toDetailNode('Variabili d\'ambiente', env, 'Nessuna variabile definita'));
		groups.push(toDetailNode('Volumi', volumes, 'Nessun volume montato'));
		return groups;
	}
}

function toDetailNode(title: string, items: string[], emptyLabel: string): TreeNode {
	if (items.length === 0) {
		return { kind: 'message', label: `${title}: ${emptyLabel}` };
	}
	return { kind: 'detailGroup', title, items };
}

function describeServiceRole(isMain: boolean, inRunServices: boolean): string {
	if (isMain) {
		return 'service principale';
	}
	if (inRunServices) {
		return 'runServices';
	}
	return 'non avviato';
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
