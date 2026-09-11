import * as vscode from 'vscode';
import { ConfigTreeProvider } from './configTreeProvider';

export function activate(context: vscode.ExtensionContext): void {
	const configTreeProvider = new ConfigTreeProvider();

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('devcontainerGui.configView', configTreeProvider),
		vscode.commands.registerCommand('devcontainerGui.refresh', () => configTreeProvider.refresh())
	);
}

export function deactivate(): void {}
