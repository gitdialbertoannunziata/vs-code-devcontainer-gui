import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import { ConfigTreeProvider, TreeNode, isEnvItemNode, isServiceNode } from './configTreeProvider';
import { ComposeLifecycleAction, ContainerCandidate, composeBaseArgs, runComposeLifecycleAction, setEnvironmentVariable } from './devcontainerConfig';

interface LogStream {
	channel: vscode.OutputChannel;
	process: ChildProcess;
}

export function activate(context: vscode.ExtensionContext): void {
	const configTreeProvider = new ConfigTreeProvider(context);
	const logStreams = new Map<string, LogStream>();

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
		vscode.commands.registerCommand('devcontainerGui.viewLogs', (node: TreeNode) => viewServiceLogs(node, logStreams)),
		vscode.commands.registerCommand('devcontainerGui.editEnvVar', (node: TreeNode) => editEnvVar(node, configTreeProvider)),
		{
			dispose() {
				for (const { process, channel } of logStreams.values()) {
					process.kill();
					channel.dispose();
				}
				logStreams.clear();
			}
		}
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

/**
 * Non usiamo un terminale integrato: anche con extensionKind "ui", i terminali
 * creati da vscode.window.createTerminal girano nel contesto del workspace
 * (dentro al container se la finestra è attaccata), mentre `docker compose`
 * va invocato sull'host con i path host — esattamente come start/stop/restart.
 * Per lo streaming usiamo quindi un processo host + un Output Channel.
 */
function viewServiceLogs(node: TreeNode, logStreams: Map<string, LogStream>): void {
	if (!isServiceNode(node)) {
		return;
	}

	const key = `${node.config.baseDir}::${node.config.projectName}::${node.name}`;
	const existing = logStreams.get(key);
	if (existing) {
		existing.process.kill();
		logStreams.delete(key);
	}

	const channel = existing?.channel ?? vscode.window.createOutputChannel(`Devcontainer log: ${node.name}`);
	channel.clear();
	channel.show(true);

	const args = ['compose', ...composeBaseArgs(node.config.composeFiles, node.config.projectName), 'logs', '-f', '--tail', '200', node.name];
	const child = spawn('docker', args, { cwd: node.config.baseDir });

	child.stdout.on('data', (chunk: Buffer) => channel.append(chunk.toString()));
	child.stderr.on('data', (chunk: Buffer) => channel.append(chunk.toString()));
	child.on('error', err => channel.appendLine(`\n[errore avvio "docker compose logs": ${err.message}]`));
	child.on('exit', () => logStreams.delete(key));

	logStreams.set(key, { channel, process: child });
}

async function editEnvVar(node: TreeNode, provider: ConfigTreeProvider): Promise<void> {
	if (!isEnvItemNode(node) || !node.source) {
		return;
	}
	const newValue = await vscode.window.showInputBox({
		prompt: `Nuovo valore per ${node.key} (servizio "${node.serviceName}")`,
		value: node.value
	});
	if (newValue === undefined || newValue === node.value) {
		return;
	}
	try {
		await setEnvironmentVariable(node.source, node.serviceName, node.key, newValue);
		// Un file .env viene riletto solo ricreando il container: per il service
		// principale evitiamo di suggerire un recreate diretto (romperebbe la
		// connessione della finestra attaccata) e rimandiamo al rebuild ufficiale.
		const needsRebuild = node.source.kind === 'envFile' || node.isMainService;
		vscode.window.showInformationMessage(
			needsRebuild
				? `"${node.key}" aggiornata. Serve un rebuild del devcontainer (comando "Dev Containers: Rebuild Container") perché il cambiamento abbia effetto.`
				: `"${node.key}" aggiornata. Il container esistente non la vede finché non lo ricrei (docker compose up -d --force-recreate).`
		);
	} catch (err) {
		vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
	}
	provider.refresh();
}

export function deactivate(): void {}
