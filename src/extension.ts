import * as vscode from 'vscode';
import { ConfigTreeProvider, TreeNode, isServiceNode } from './configTreeProvider';
import { ComposeLifecycleAction, ContainerCandidate, composeBaseArgs, runComposeLifecycleAction } from './devcontainerConfig';

export function activate(context: vscode.ExtensionContext): void {
	const configTreeProvider = new ConfigTreeProvider(context);

	const registerLifecycleCommand = (command: string, action: ComposeLifecycleAction) =>
		vscode.commands.registerCommand(command, (node: TreeNode) => runLifecycleCommand(node, action, configTreeProvider));

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('devcontainerGui.configView', configTreeProvider),
		vscode.commands.registerCommand('devcontainerGui.refresh', () => configTreeProvider.refresh()),
		vscode.commands.registerCommand('devcontainerGui.selectContainer', (candidates: ContainerCandidate[]) =>
			configTreeProvider.selectPreferredContainer(candidates)
		),
		registerLifecycleCommand('devcontainerGui.startService', 'start'),
		registerLifecycleCommand('devcontainerGui.stopService', 'stop'),
		registerLifecycleCommand('devcontainerGui.restartService', 'restart'),
		vscode.commands.registerCommand('devcontainerGui.viewLogs', (node: TreeNode) => viewServiceLogs(node))
	);
}

async function runLifecycleCommand(node: TreeNode, action: ComposeLifecycleAction, provider: ConfigTreeProvider): Promise<void> {
	if (!isServiceNode(node)) {
		return;
	}
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: `docker compose ${action}: ${node.name}` },
			() => runComposeLifecycleAction(node.config, node.name, action)
		);
	} catch (err) {
		vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
	}
	provider.refresh();
}

function viewServiceLogs(node: TreeNode): void {
	if (!isServiceNode(node)) {
		return;
	}
	const args = composeBaseArgs(node.config.composeFiles, node.config.projectName).concat(['logs', '-f', '--tail', '200', node.name]);
	const commandLine = ['docker', 'compose', ...args].map(quoteForTerminal).join(' ');

	const terminal = vscode.window.createTerminal({ name: `Log: ${node.name}`, cwd: node.config.baseDir });
	terminal.show();
	terminal.sendText(commandLine);
}

function quoteForTerminal(arg: string): string {
	return /\s/.test(arg) ? `"${arg}"` : arg;
}

export function deactivate(): void {}
