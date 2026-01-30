#!/usr/bin/env bun
import { parseArgs } from "./cli/args.ts";
import { addRule, showConfig } from "./cli/commands/config.ts";
import { runHello } from "./cli/commands/hello.ts";
import { runInit } from "./cli/commands/init.ts";
import { runLoop } from "./cli/commands/run.ts";
import { runTask } from "./cli/commands/task.ts";
import { flushAllProgressWrites } from "./config/writer.ts";
import { logError } from "./ui/logger.ts";

async function main(): Promise<void> {
	try {
		const {
			options,
			task,
			initMode,
			helloMode,
			showConfig: showConfigMode,
			addRule: rule,
			configPath,
		} = parseArgs(process.argv);

		// Handle --hello
		if (helloMode) {
			await runHello();
			return;
		}

		// Handle --init
		if (initMode) {
			await runInit();
			return;
		}

		// Handle --config
		if (showConfigMode) {
			await showConfig(undefined, configPath);
			return;
		}

		// Handle --add-rule
		if (rule) {
			await addRule(rule, undefined, configPath);
			return;
		}

		// Single task mode (brownfield)
		if (task) {
			await runTask(task, options);
			return;
		}

		// PRD loop mode
		await runLoop(options);
	} catch (error) {
		logError(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		// Ensure all progress writes are flushed before exit
		await flushAllProgressWrites();
	}
}

main();
