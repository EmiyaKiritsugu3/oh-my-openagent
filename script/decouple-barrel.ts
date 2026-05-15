import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, dirname, relative, resolve } from "path";

// 1. Build a map of symbol -> file path in shared
const sharedDir = resolve("src/shared");
const indexFile = join(sharedDir, "index.ts");
const indexContent = readFileSync(indexFile, "utf-8");

const exportRegex = /export\s+(?:type\s+)?{([^}]+)}\s+from\s+["']([^"']+)["']/g;
const exportAllRegex = /export\s+\*\s+from\s+["']([^"']+)["']/g;

const symbolToFile = new Map<string, string>();

let match;
while ((match = exportRegex.exec(indexContent)) !== null) {
  const symbols = match[1].split(",").map(s => s.trim()).filter(Boolean);
  const file = match[2].replace(/^\.\//, "");
  for (const sym of symbols) {
    symbolToFile.set(sym, file);
  }
}

while ((match = exportAllRegex.exec(indexContent)) !== null) {
  const file = match[1].replace(/^\.\//, "");
  const fullPath = join(sharedDir, file + ".ts");
  if (!require("fs").existsSync(fullPath)) continue;
  
  const content = readFileSync(fullPath, "utf-8");
  // Basic export extraction
  const exportSyms = content.match(/export\s+(?:async\s+)?(?:const|let|var|function|class|interface|type)\s+([a-zA-Z0-9_]+)/g);
  if (exportSyms) {
    for (const exp of exportSyms) {
      const symName = exp.split(/\s+/).pop();
      if (symName) symbolToFile.set(symName, file);
    }
  }
}

// Manually add some known ones if missed by basic regex
symbolToFile.set("log", "logger");
symbolToFile.set("normalizeSDKResponse", "normalize-sdk-response");
symbolToFile.set("PLUGIN_NAME", "plugin-identity");
symbolToFile.set("getOpenCodeConfigDir", "opencode-config-dir");
symbolToFile.set("addConfigLoadError", "config-errors");

console.log("Built symbol map with", symbolToFile.size, "symbols.");

// 2. Scan and replace in all TS files
function scanDir(dir: string) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      scanDir(fullPath);
    } else if (fullPath.endsWith(".ts")) {
      processFile(fullPath);
    }
  }
}

function processFile(filePath: string) {
  let content = readFileSync(filePath, "utf-8");
  let modified = false;

  const importRegex = /import\s+(?:type\s+)?{([^}]+)}\s+from\s+["']((?:\.\.\/)+shared|\.\/shared)["']/g;
  
  content = content.replace(importRegex, (match, importsStr, importPath) => {
    const symbols = importsStr.split(",").map((s: string) => s.trim()).filter(Boolean);
    const byFile = new Map<string, string[]>();
    
    let allMapped = true;
    for (const sym of symbols) {
      const symClean = sym.split(/\s+as\s+/)[0]; // handle "import { A as B }"
      const mappedFile = symbolToFile.get(symClean);
      if (mappedFile) {
        const list = byFile.get(mappedFile) || [];
        list.push(sym);
        byFile.set(mappedFile, list);
      } else {
        // If we can't map one, we keep it in the original import (not ideal, but safe)
        allMapped = false;
        const list = byFile.get("INDEX") || [];
        list.push(sym);
        byFile.set("INDEX", list);
      }
    }

    if (byFile.size === 1 && byFile.has("INDEX")) {
      return match; // Nothing mapped
    }

    modified = true;
    let replacement = "";
    for (const [file, syms] of byFile.entries()) {
      if (file === "INDEX") {
        replacement += `import { ${syms.join(", ")} } from "${importPath}"\n`;
      } else {
        replacement += `import { ${syms.join(", ")} } from "${importPath}/${file}"\n`;
      }
    }
    return replacement.trim();
  });

  if (modified) {
    writeFileSync(filePath, content, "utf-8");
    console.log("Updated", filePath);
  }
}

scanDir(resolve("src"));
