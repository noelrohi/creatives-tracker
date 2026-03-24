import Table from "cli-table3";
function formatCell(value) {
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return JSON.stringify(value);
}
function printTable(value) {
    if (Array.isArray(value)) {
        if (value.length === 0) {
            console.log("[]");
            return;
        }
        const rows = value.filter((row) => Boolean(row) && typeof row === "object" && !Array.isArray(row));
        if (rows.length !== value.length) {
            console.log(JSON.stringify(value, null, 2));
            return;
        }
        const head = Array.from(rows.reduce((keys, row) => {
            for (const key of Object.keys(row)) {
                keys.add(key);
            }
            return keys;
        }, new Set()));
        const table = new Table({ head });
        for (const row of rows) {
            table.push(head.map((key) => formatCell(row[key])));
        }
        console.log(table.toString());
        return;
    }
    if (value && typeof value === "object") {
        const table = new Table({
            head: ["Field", "Value"],
            colWidths: [24, 80],
            wordWrap: true,
        });
        for (const [key, cellValue] of Object.entries(value)) {
            table.push([key, formatCell(cellValue)]);
        }
        console.log(table.toString());
        return;
    }
    console.log(formatCell(value));
}
export function printOutput(value, asTable) {
    if (asTable) {
        printTable(value);
        return;
    }
    console.log(JSON.stringify(value, null, 2));
}
