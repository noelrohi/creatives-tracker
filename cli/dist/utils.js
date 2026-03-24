import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Papa from "papaparse";
import { TRPCClientError } from "@trpc/client";
import { createApiClient, getGlobalOptions, resolveApiUrl } from "./client.js";
import { printOutput } from "./output.js";
export function parseList(value) {
    if (!value) {
        return undefined;
    }
    const items = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    return items.length > 0 ? items : undefined;
}
export function compactObject(value) {
    return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}
export function parseInteger(value) {
    if (value === undefined) {
        return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        throw new Error(`Expected an integer, received "${value}"`);
    }
    return parsed;
}
export async function readCsvRows(filePath, integerFields = []) {
    const content = await readFile(resolve(filePath), "utf8");
    const parsed = Papa.parse(content, {
        header: true,
        skipEmptyLines: true,
    });
    if (parsed.errors.length > 0) {
        throw new Error(parsed.errors.map((error) => error.message).join("; "));
    }
    return parsed.data.map((row) => {
        const normalized = {};
        for (const [key, rawValue] of Object.entries(row)) {
            if (!key) {
                continue;
            }
            const value = typeof rawValue === "string" ? rawValue.trim() : rawValue;
            if (value === "" || value === undefined) {
                continue;
            }
            if (integerFields.includes(key)) {
                const parsedInteger = Number.parseInt(value, 10);
                normalized[key] = Number.isNaN(parsedInteger) ? value : parsedInteger;
                continue;
            }
            normalized[key] = value;
        }
        return normalized;
    });
}
export async function runCommand(command, action) {
    try {
        const client = createApiClient(resolveApiUrl(command));
        const result = await action(client);
        if (result !== undefined) {
            printOutput(result, Boolean(getGlobalOptions(command).table));
        }
    }
    catch (error) {
        if (error instanceof TRPCClientError) {
            console.error(error.message);
            process.exitCode = 1;
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = 1;
    }
}
