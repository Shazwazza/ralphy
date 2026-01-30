import { logInfo } from "../../ui/logger.ts";

export async function runHello(): Promise<void> {
	logInfo("Hello!");
}
