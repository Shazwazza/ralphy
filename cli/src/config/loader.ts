import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { type RalphyConfig, RalphyConfigSchema } from "./types.ts";

export const RALPHY_DIR = ".ralphy";
export const CONFIG_FILE = "config.yaml";
export const PROGRESS_FILE = "progress.txt";

/**
 * Get the full path to the ralphy directory
 */
export function getRalphyDir(workDir = process.cwd()): string {
	return join(workDir, RALPHY_DIR);
}

/**
 * Get the full path to the config file
 */
export function getConfigPath(workDir = process.cwd(), customPath?: string): string {
	if (customPath) {
		// Support both absolute and relative paths
		return customPath.startsWith("/") || customPath.includes(":")
			? customPath
			: join(workDir, customPath);
	}
	return join(workDir, RALPHY_DIR, CONFIG_FILE);
}

/**
 * Get the full path to the progress file
 */
export function getProgressPath(workDir = process.cwd()): string {
	return join(workDir, RALPHY_DIR, PROGRESS_FILE);
}

/**
 * Check if ralphy is initialized in the directory
 */
export function isInitialized(workDir = process.cwd(), customPath?: string): boolean {
	return existsSync(getConfigPath(workDir, customPath));
}

/**
 * Load the ralphy config from disk
 */
export function loadConfig(workDir = process.cwd(), customPath?: string): RalphyConfig | null {
	const configPath = getConfigPath(workDir, customPath);

	if (!existsSync(configPath)) {
		return null;
	}

	try {
		const content = readFileSync(configPath, "utf-8");
		const parsed = YAML.parse(content);
		return RalphyConfigSchema.parse(parsed);
	} catch (error) {
		// Log error for debugging, but return default config
		console.error(`Warning: Failed to parse config at ${configPath}:`, error);
		return RalphyConfigSchema.parse({});
	}
}

/**
 * Get rules from config
 */
export function loadRules(workDir = process.cwd(), customPath?: string): string[] {
	const config = loadConfig(workDir, customPath);
	return config?.rules ?? [];
}

/**
 * Get boundaries from config
 */
export function loadBoundaries(workDir = process.cwd(), customPath?: string): string[] {
	const config = loadConfig(workDir, customPath);
	return config?.boundaries.never_touch ?? [];
}

/**
 * Get test command from config
 */
export function loadTestCommand(workDir = process.cwd(), customPath?: string): string {
	const config = loadConfig(workDir, customPath);
	return config?.commands.test ?? "";
}

/**
 * Get lint command from config
 */
export function loadLintCommand(workDir = process.cwd(), customPath?: string): string {
	const config = loadConfig(workDir, customPath);
	return config?.commands.lint ?? "";
}

/**
 * Get build command from config
 */
export function loadBuildCommand(workDir = process.cwd(), customPath?: string): string {
	const config = loadConfig(workDir, customPath);
	return config?.commands.build ?? "";
}

/**
 * Get project context as a formatted string
 */
export function loadProjectContext(workDir = process.cwd(), customPath?: string): string {
	const config = loadConfig(workDir, customPath);
	if (!config) return "";

	const parts: string[] = [];
	if (config.project.name) parts.push(`Project: ${config.project.name}`);
	if (config.project.language) parts.push(`Language: ${config.project.language}`);
	if (config.project.framework) parts.push(`Framework: ${config.project.framework}`);
	if (config.project.description) parts.push(`Description: ${config.project.description}`);

	return parts.join("\n");
}
