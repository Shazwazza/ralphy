import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { logDebug } from "../ui/logger.ts";
import { BaseAIEngine, commandExists } from "./base.ts";
import type { AIResult, EngineOptions, ProgressCallback } from "./types.ts";

/**
 * GitHub Copilot CLI AI Engine using Agent Client Protocol (ACP)
 *
 * This implementation uses the ACP protocol for structured communication
 * with Copilot CLI instead of parsing text output. Benefits:
 * - Structured NDJSON protocol communication
 * - Real streaming via agent_message_chunk events
 * - Direct access to token counts from protocol
 * - Better error handling with structured responses
 * - No fragile text parsing or temporary files
 */
export class CopilotAcpEngine extends BaseAIEngine {
	name = "GitHub Copilot";
	cliCommand = "copilot";

	/**
	 * Start Copilot CLI in ACP server mode and create a connection
	 */
	private async createAcpConnection(workDir: string): Promise<{
		connection: acp.ClientSideConnection;
		process: ReturnType<typeof spawn>;
	}> {
		const executable = process.env.COPILOT_CLI_PATH || this.cliCommand;

		logDebug(`[Copilot ACP] Starting ACP server: ${executable} --acp --stdio`);

		// Start Copilot CLI in ACP stdio mode
		const copilotProcess = spawn(executable, ["--acp", "--stdio"], {
			cwd: workDir,
			stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr
		});

		if (!copilotProcess.stdin || !copilotProcess.stdout) {
			throw new Error("Failed to start Copilot ACP process with piped stdio.");
		}

		// Log stderr for debugging
		if (copilotProcess.stderr) {
			copilotProcess.stderr.on("data", (data) => {
				logDebug(`[Copilot ACP stderr] ${data.toString()}`);
			});
		}

		// Create ACP streams (NDJSON over stdio)
		const output = Writable.toWeb(copilotProcess.stdin) as WritableStream<Uint8Array>;
		const input = Readable.toWeb(copilotProcess.stdout) as ReadableStream<Uint8Array>;
		const stream = acp.ndJsonStream(output, input);

		// Create client implementation
		const client: acp.Client = {
			async requestPermission(_params) {
				// In yolo mode, auto-approve all tool/permission requests
				logDebug("[Copilot ACP] Auto-approving permission request (yolo mode)");
				return { outcome: { outcome: "approved" } };
			},

			async sessionUpdate(_params) {
				// Session updates are handled per-request in execute/executeStreaming
			},
		};

		const connection = new acp.ClientSideConnection((_agent) => client, stream);

		// Initialize the ACP connection
		logDebug("[Copilot ACP] Initializing connection");
		await connection.initialize({
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});

		logDebug("[Copilot ACP] Connection initialized");

		return { connection, process: copilotProcess };
	}

	/**
	 * Cleanup ACP connection and process
	 */
	private async cleanupAcpConnection(
		process: ReturnType<typeof spawn>,
		sessionId?: string,
		connection?: acp.ClientSideConnection,
	): Promise<void> {
		try {
			// End session if exists
			if (sessionId && connection) {
				logDebug(`[Copilot ACP] Ending session: ${sessionId}`);
				await connection.endSession({ sessionId }).catch((err) => {
					logDebug(`[Copilot ACP] Failed to end session: ${err.message}`);
				});
			}

			// Close stdin to signal end of input
			if (process.stdin) {
				process.stdin.end();
			}

			// Kill the process
			process.kill("SIGTERM");

			// Wait for process to exit (with timeout)
			await new Promise<void>((resolve) => {
				process.once("exit", () => {
					logDebug("[Copilot ACP] Process exited");
					resolve();
				});
				setTimeout(() => {
					logDebug("[Copilot ACP] Process cleanup timeout");
					resolve();
				}, 2000);
			});
		} catch (err) {
			logDebug(`[Copilot ACP] Cleanup error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Build prompt content array for ACP
	 */
	private buildPromptContent(prompt: string, options?: EngineOptions): acp.PromptContent[] {
		const content: acp.PromptContent[] = [{ type: "text", text: prompt }];

		// Add model override as instruction if provided
		if (options?.modelOverride) {
			content.unshift({
				type: "text",
				text: `[Use model: ${options.modelOverride}]`,
			});
		}

		return content;
	}

	async execute(prompt: string, workDir: string, options?: EngineOptions): Promise<AIResult> {
		let connection: acp.ClientSideConnection | undefined;
		let copilotProcess: ReturnType<typeof spawn> | undefined;
		let sessionId: string | undefined;

		try {
			const startTime = Date.now();

			// Create ACP connection
			const acpConnection = await this.createAcpConnection(workDir);
			connection = acpConnection.connection;
			copilotProcess = acpConnection.process;

			// Create new session
			logDebug(`[Copilot ACP] Creating new session in: ${workDir}`);
			const sessionResult = await connection.newSession({
				cwd: workDir,
				mcpServers: [],
			});
			sessionId = sessionResult.sessionId;
			logDebug(`[Copilot ACP] Session created: ${sessionId}`);

			// Build prompt content
			const promptContent = this.buildPromptContent(prompt, options);
			logDebug(`[Copilot ACP] Sending prompt (${prompt.length} chars)`);

			// Accumulate response chunks
			let response = "";
			let inputTokens = 0;
			let outputTokens = 0;

			// Override sessionUpdate to capture chunks for this specific request
			const originalClient = (connection as any).clientProvider;
			(connection as any).clientProvider = (agent: any) => {
				const client = originalClient(agent);
				return {
					...client,
					async sessionUpdate(params: acp.SessionUpdateParams) {
						const update = params.update;

						// Capture text chunks
						if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
							response += update.content.text;
						}

						// Call original handler
						if (client.sessionUpdate) {
							await client.sessionUpdate(params);
						}
					},
				};
			};

			// Send prompt
			const promptResult = await connection.prompt({
				sessionId,
				prompt: promptContent,
			});

			const durationMs = Date.now() - startTime;

			logDebug(`[Copilot ACP] Prompt completed with stopReason: ${promptResult.stopReason}`);
			logDebug(`[Copilot ACP] Response length: ${response.length} chars`);

			// Extract token counts from usage data if available
			if (promptResult.usage) {
				inputTokens = promptResult.usage.inputTokens || 0;
				outputTokens = promptResult.usage.outputTokens || 0;
				logDebug(`[Copilot ACP] Tokens: ${inputTokens} in, ${outputTokens} out`);
			}

			// Check for error stop reasons
			if (promptResult.stopReason === "error") {
				return {
					success: false,
					response: response || "An error occurred",
					inputTokens,
					outputTokens,
					error: "Copilot CLI returned an error",
				};
			}

			if (promptResult.stopReason === "cancelled") {
				return {
					success: false,
					response: response || "Request was cancelled",
					inputTokens,
					outputTokens,
					error: "Request was cancelled",
				};
			}

			return {
				success: true,
				response: response || "Task completed",
				inputTokens,
				outputTokens,
				cost: durationMs > 0 ? `duration:${durationMs}` : undefined,
			};
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			logDebug(`[Copilot ACP] Error: ${errorMessage}`);

			// Check for authentication errors
			if (
				errorMessage.toLowerCase().includes("authentication") ||
				errorMessage.toLowerCase().includes("not authenticated")
			) {
				return {
					success: false,
					response: "",
					inputTokens: 0,
					outputTokens: 0,
					error:
						"GitHub Copilot CLI is not authenticated. Run 'copilot' and use '/login' to authenticate, or set COPILOT_GITHUB_TOKEN environment variable.",
				};
			}

			return {
				success: false,
				response: "",
				inputTokens: 0,
				outputTokens: 0,
				error: `Failed to execute prompt: ${errorMessage}`,
			};
		} finally {
			// Always cleanup
			if (copilotProcess) {
				await this.cleanupAcpConnection(copilotProcess, sessionId, connection);
			}
		}
	}

	async executeStreaming(
		prompt: string,
		workDir: string,
		onProgress: ProgressCallback,
		options?: EngineOptions,
	): Promise<AIResult> {
		let connection: acp.ClientSideConnection | undefined;
		let copilotProcess: ReturnType<typeof spawn> | undefined;
		let sessionId: string | undefined;

		try {
			const startTime = Date.now();

			// Create ACP connection
			const acpConnection = await this.createAcpConnection(workDir);
			connection = acpConnection.connection;
			copilotProcess = acpConnection.process;

			// Create new session
			logDebug(`[Copilot ACP] Creating new session in: ${workDir}`);
			const sessionResult = await connection.newSession({
				cwd: workDir,
				mcpServers: [],
			});
			sessionId = sessionResult.sessionId;
			logDebug(`[Copilot ACP] Session created: ${sessionId}`);

			// Build prompt content
			const promptContent = this.buildPromptContent(prompt, options);
			logDebug(`[Copilot ACP] Sending prompt (${prompt.length} chars) with streaming`);

			// Accumulate response chunks
			let response = "";
			let inputTokens = 0;
			let outputTokens = 0;
			let lastProgressUpdate = "";

			// Override sessionUpdate to capture chunks and call progress callback
			const originalClient = (connection as any).clientProvider;
			(connection as any).clientProvider = (agent: any) => {
				const client = originalClient(agent);
				return {
					...client,
					async sessionUpdate(params: acp.SessionUpdateParams) {
						const update = params.update;

						// Capture and stream text chunks
						if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
							response += update.content.text;

							// Update progress with a preview of the response
							// Show last 50 chars to give user feedback
							const preview = response.slice(-50).replace(/\n/g, " ").trim();
							if (preview && preview !== lastProgressUpdate) {
								lastProgressUpdate = preview;
								onProgress(`Streaming: ${preview}...`);
							}
						}

						// Call original handler
						if (client.sessionUpdate) {
							await client.sessionUpdate(params);
						}
					},
				};
			};

			// Send prompt
			const promptResult = await connection.prompt({
				sessionId,
				prompt: promptContent,
			});

			const durationMs = Date.now() - startTime;

			logDebug(`[Copilot ACP] Streaming completed with stopReason: ${promptResult.stopReason}`);
			logDebug(`[Copilot ACP] Response length: ${response.length} chars`);

			// Extract token counts from usage data if available
			if (promptResult.usage) {
				inputTokens = promptResult.usage.inputTokens || 0;
				outputTokens = promptResult.usage.outputTokens || 0;
				logDebug(`[Copilot ACP] Tokens: ${inputTokens} in, ${outputTokens} out`);
			}

			// Check for error stop reasons
			if (promptResult.stopReason === "error") {
				return {
					success: false,
					response: response || "An error occurred",
					inputTokens,
					outputTokens,
					error: "Copilot CLI returned an error",
				};
			}

			if (promptResult.stopReason === "cancelled") {
				return {
					success: false,
					response: response || "Request was cancelled",
					inputTokens,
					outputTokens,
					error: "Request was cancelled",
				};
			}

			return {
				success: true,
				response: response || "Task completed",
				inputTokens,
				outputTokens,
				cost: durationMs > 0 ? `duration:${durationMs}` : undefined,
			};
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			logDebug(`[Copilot ACP] Streaming error: ${errorMessage}`);

			// Check for authentication errors
			if (
				errorMessage.toLowerCase().includes("authentication") ||
				errorMessage.toLowerCase().includes("not authenticated")
			) {
				return {
					success: false,
					response: "",
					inputTokens: 0,
					outputTokens: 0,
					error:
						"GitHub Copilot CLI is not authenticated. Run 'copilot' and use '/login' to authenticate, or set COPILOT_GITHUB_TOKEN environment variable.",
				};
			}

			return {
				success: false,
				response: "",
				inputTokens: 0,
				outputTokens: 0,
				error: `Failed to execute streaming prompt: ${errorMessage}`,
			};
		} finally {
			// Always cleanup
			if (copilotProcess) {
				await this.cleanupAcpConnection(copilotProcess, sessionId, connection);
			}
		}
	}

	async isAvailable(): Promise<boolean> {
		return commandExists(this.cliCommand);
	}
}
