import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigTreeProvider, TreeNode, isServiceNode, isEnvItemNode } from './configTreeProvider';
import { ComposeLifecycleAction, ContainerCandidate, composeBaseArgs, resolveContainerId, resolveShellPath, runComposeLifecycleAction, setEnvironmentVariable } from './devcontainerConfig';

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
		vscode.commands.registerCommand('devcontainerGui.openTerminal', (node: TreeNode) => openServiceTerminal(node)),
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
 * We don't use an integrated terminal: even with extensionKind "ui",
 * terminals created via vscode.window.createTerminal run in the workspace's
 * context (inside the container if the window is attached), while
 * `docker compose` needs to be invoked on the host with host paths — exactly
 * like start/stop/restart. So we stream via a host process + an Output
 * Channel instead.
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
	child.on('error', err => channel.appendLine(`\n[failed to start "docker compose logs": ${err.message}]`));
	child.on('exit', () => logStreams.delete(key));

	logStreams.set(key, { channel, process: child });
}

async function editEnvVar(node: TreeNode, provider: ConfigTreeProvider): Promise<void> {
	if (!isEnvItemNode(node) || !node.source) {
		return;
	}
	const newValue = await vscode.window.showInputBox({
		prompt: `New value for ${node.key} (service "${node.serviceName}")`,
		value: node.value
	});
	if (newValue === undefined || newValue === node.value) {
		return;
	}
	try {
		await setEnvironmentVariable(node.source, node.serviceName, node.key, newValue);
		// A .env file is only re-read when the container is recreated: for the
		// main service we avoid suggesting a direct recreate (it would break the
		// attached window's connection) and point to the official rebuild instead.
		const needsRebuild = node.source.kind === 'envFile' || node.isMainService;
		vscode.window.showInformationMessage(
			needsRebuild
				? `"${node.key}" updated. The devcontainer needs a rebuild ("Dev Containers: Rebuild Container") for the change to take effect.`
				: `"${node.key}" updated. The existing container won't see it until it's recreated (docker compose up -d --force-recreate).`
		);
	} catch (err) {
		vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
	}
	provider.refresh();
}

/**
 * A VS Code terminal (integrated or a custom Pseudoterminal) can't give a
 * real interactive shell here: integrated terminals run in the workspace's
 * context (inside the container if attached, wrong host paths), and a
 * Pseudoterminal has no real PTY on either end, so `docker exec -it` can't
 * be used there and everything (echo, line editing, Ctrl+C) would have to be
 * emulated by hand — which turned out too fragile in practice. Instead we do
 * what Docker Desktop's "Open in terminal" does: launch a real OS terminal
 * application outside VS Code, which has a genuine PTY, so `-it` works
 * exactly as it normally would.
 */
async function openServiceTerminal(node: TreeNode): Promise<void> {
	if (!isServiceNode(node)) {
		return;
	}
	const containerId = await resolveContainerId(node.config, node.name);
	if (!containerId) {
		vscode.window.showErrorMessage(`Service "${node.name}" isn't running — start it first.`);
		return;
	}
	// Plain `docker exec -it <id> <shell>`, exactly as simple as Docker
	// Desktop's own "Open in terminal" — no `-c "... || ..."` wrapper, which
	// had its own quoting/operator characters that a shell somewhere along
	// the way (ours or the container's) could misparse.
	const shellPath = await resolveShellPath(containerId);
	const dockerCommand = ['docker', 'exec', '-it', containerId, shellPath];
	try {
		launchExternalTerminal(dockerCommand, node.config.baseDir);
	} catch (err) {
		vscode.window.showErrorMessage(`Could not open a terminal: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function launchExternalTerminal(commandParts: string[], cwd: string): void {
	let child: ReturnType<typeof spawn>;
	if (process.platform === 'win32') {
		// Passing the whole command line as one argv element and letting Node
		// apply ITS OWN Windows quoting on top of our manual quoting double-
		// escapes it — cmd.exe can end up not even recognizing `/k`, so the
		// window opens and immediately closes with nothing visible. Writing
		// the command to a .bat file sidesteps that: the process command line
		// becomes just a plain file path, and `pause` at the end keeps the
		// window open regardless of /k, as a second safety net.
		const commandLine = commandParts.map(quoteForCmd).join(' ');
		const scriptPath = path.join(os.tmpdir(), `devcontainer-gui-shell-${Date.now()}.bat`);
		fs.writeFileSync(scriptPath, `@echo off\r\ncd /d "${cwd}"\r\n${commandLine}\r\necho.\r\npause\r\n`, 'utf8');
		child = spawn('cmd.exe', ['/k', scriptPath], { detached: true, stdio: 'ignore' });
		child.on('exit', () => fs.unlink(scriptPath, () => { /* best effort cleanup */ }));
	} else if (process.platform === 'darwin') {
		const commandLine = commandParts.map(quoteForShell).join(' ');
		const script = `tell application "Terminal" to do script "cd ${appleScriptEscape(cwd)} && ${appleScriptEscape(commandLine)}"`;
		child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
	} else {
		const commandLine = commandParts.map(quoteForShell).join(' ');
		child = spawn('x-terminal-emulator', ['-e', 'sh', '-c', `cd ${quoteForShell(cwd)} && ${commandLine}`], { detached: true, stdio: 'ignore' });
	}
	// spawn() doesn't throw synchronously for a missing/failing executable;
	// without this listener the failure is invisible (looks like "the button
	// does nothing"), and an unhandled "error" on an EventEmitter is fatal.
	child.on('error', err => vscode.window.showErrorMessage(`Could not open a terminal: ${err.message}`));
	child.unref();
}

function quoteForCmd(arg: string): string {
	return /[\s"^&|<>]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function quoteForShell(arg: string): string {
	return /\s/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg;
}

function appleScriptEscape(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function deactivate(): void {}
