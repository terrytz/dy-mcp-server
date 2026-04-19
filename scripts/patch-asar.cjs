#!/usr/bin/env node
// patch-asar.js — Binary-patch app.asar to inject api-server.js require into preload.js.
// No repacking needed — directly modifies the asar, preserving all offsets and native module refs.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const INJECT_LINE = `\ntry{require(require("path").join(process.resourcesPath,"api-server.js"))}catch(e){console.error("[dy-api] inject failed:",e)}\n`;
const SOURCEMAP_SUFFIX = `\n//# sourceMappingURL=preload.js.map`;

function parseAsarHeader(buf) {
  // Asar uses Chromium pickle format:
  // [4 bytes: pickle payload size] [4 bytes: header string size inside pickle]
  // [4 bytes: header string length] [header JSON string] ... [file data]
  const payloadSize = buf.readUInt32LE(4);
  const headerStringSize = buf.readUInt32LE(12);
  const headerJson = buf.slice(16, 16 + headerStringSize).toString();
  const header = JSON.parse(headerJson);
  const dataStart = 8 + payloadSize;
  return { header, headerJson, headerStringSize, payloadSize, dataStart };
}

function writeAsarHeader(header) {
  const headerString = JSON.stringify(header);
  const headerStringBuf = Buffer.from(headerString);
  const stringLen = headerStringBuf.length;

  // Asar uses double-nested Chromium pickle format:
  // [4: const 4] [4: payloadSize] [4: innerSize] [4: stringLen] [string]
  // payloadSize = stringLen + 8
  // innerSize   = stringLen + 4
  // dataStart   = 8 + payloadSize = stringLen + 16
  const payloadSize = stringLen + 8;
  const innerSize = stringLen + 4;

  const headerBuf = Buffer.alloc(16 + stringLen);
  headerBuf.writeUInt32LE(4, 0);            // chromium pickle header (always 4)
  headerBuf.writeUInt32LE(payloadSize, 4);  // payload size
  headerBuf.writeUInt32LE(innerSize, 8);    // inner size
  headerBuf.writeUInt32LE(stringLen, 12);   // JSON string length
  headerStringBuf.copy(headerBuf, 16);      // JSON string

  return headerBuf;
}

function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || "patch";

  const resources = "/Applications/抖音聊天.app/Contents/Resources";
  const asarPath = path.join(resources, "app.asar");
  const backupPath = path.join(resources, "app.asar.bak");
  const apiServerSrc = path.join(__dirname, "..", "src", "injected", "api-server.js");
  const apiServerDst = path.join(resources, "api-server.js");

  if (mode === "restore") {
    if (!fs.existsSync(backupPath)) {
      console.error("No backup found at", backupPath);
      process.exit(1);
    }
    fs.copyFileSync(backupPath, asarPath);
    try { fs.unlinkSync(apiServerDst); } catch {}
    // Restore the original asar integrity hash in Info.plist
    const infoPlist = path.join(resources, "..", "Info.plist");
    if (fs.existsSync(infoPlist)) {
      const asarHash = crypto.createHash("sha256").update(fs.readFileSync(asarPath)).digest("hex");
      const { execSync } = require("child_process");
      execSync(`/usr/libexec/PlistBuddy -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash ${asarHash}" "${infoPlist}"`);
    }
    console.log("Restored original app.asar from backup.");
    return;
  }

  if (mode === "status") {
    if (!fs.existsSync(apiServerDst)) {
      console.log("NOT patched (api-server.js not found in Resources)");
      process.exit(1);
    }
    const buf = fs.readFileSync(asarPath);
    const { header, dataStart } = parseAsarHeader(buf);
    const preload = header.files["preload.js"];
    const fileStart = dataStart + parseInt(preload.offset);
    const content = buf.slice(fileStart, fileStart + preload.size).toString();
    if (content.includes("api-server.js")) {
      console.log("PATCHED (api-server.js injection present in preload.js)");
    } else {
      console.log("NOT patched (preload.js is stock)");
      process.exit(1);
    }
    return;
  }

  // --- Patch mode ---
  if (!fs.existsSync(asarPath)) {
    console.error("app.asar not found at", asarPath);
    process.exit(1);
  }
  if (!fs.existsSync(apiServerSrc)) {
    console.error("api-server.js not found at", apiServerSrc);
    process.exit(1);
  }

  // Back up original
  const sourceAsar = fs.existsSync(backupPath) ? backupPath : asarPath;
  if (!fs.existsSync(backupPath)) {
    console.log("  Backing up original app.asar...");
    fs.copyFileSync(asarPath, backupPath);
  }

  // Always patch from the backup (clean base)
  const buf = Buffer.from(fs.readFileSync(sourceAsar));
  const { header, dataStart } = parseAsarHeader(buf);

  const preload = header.files["preload.js"];
  if (!preload) {
    console.error("preload.js not found in asar header");
    process.exit(1);
  }

  const fileStart = dataStart + parseInt(preload.offset);
  const originalContent = buf.slice(fileStart, fileStart + preload.size).toString();

  if (originalContent.includes("api-server.js")) {
    console.log("  Already patched. Updating api-server.js...");
    fs.copyFileSync(apiServerSrc, apiServerDst);
    console.log("Done.");
    return;
  }

  // Replace the sourcemap comment with our injection
  let newContent;
  if (originalContent.endsWith(SOURCEMAP_SUFFIX)) {
    // Replace the useless sourcemap with our require
    newContent = originalContent.slice(0, -SOURCEMAP_SUFFIX.length) + INJECT_LINE;
  } else {
    // Just append
    newContent = originalContent + INJECT_LINE;
  }

  const newContentBuf = Buffer.from(newContent);
  const sizeDiff = newContentBuf.length - preload.size;

  // Update the header with the new preload.js size and integrity
  preload.size = newContentBuf.length;
  const hash = crypto.createHash("sha256").update(newContentBuf).digest("hex");
  if (preload.integrity) {
    preload.integrity.hash = hash;
    preload.integrity.blocks = [hash];
  }

  // Rebuild the asar: new header + data before preload + new preload + data after preload
  const newHeaderBuf = writeAsarHeader(header);
  const newDataStart = newHeaderBuf.length;

  // The header size change shifts ALL file data. We need to keep offsets correct.
  // Since we only changed preload.js size, and preload is not the last file,
  // files after preload have their data shifted by sizeDiff.
  // BUT: asar offsets are relative to the data section start, which is right after the header.
  // If the header size changes, the data section start changes, but offsets within the data
  // section stay the same... EXCEPT that preload.js is now a different size.
  //
  // Strategy: Rebuild data section with the modified preload.js content.

  const oldDataSection = buf.slice(dataStart);

  // Build new data section: everything before preload + new preload + everything after
  const preloadOffset = parseInt(preload.offset);
  const beforePreload = oldDataSection.slice(0, preloadOffset);
  const afterPreload = oldDataSection.slice(preloadOffset + (preload.size - sizeDiff)); // original size

  // Now update offsets for files that come after preload.js in the data section
  function updateOffsets(files, shift) {
    for (const [name, entry] of Object.entries(files)) {
      if (entry.files) {
        updateOffsets(entry.files, shift);
      } else if (entry.offset !== undefined) {
        const off = parseInt(entry.offset);
        if (off > preloadOffset) {
          entry.offset = String(off + shift);
        }
      }
    }
  }
  updateOffsets(header.files, sizeDiff);

  // Rebuild header with updated offsets
  const finalHeaderBuf = writeAsarHeader(header);

  // Assemble the final asar
  const newDataSection = Buffer.concat([beforePreload, newContentBuf, afterPreload]);
  const finalAsar = Buffer.concat([finalHeaderBuf, newDataSection]);

  // Write it
  console.log("  Writing patched app.asar...");
  fs.writeFileSync(asarPath, finalAsar);

  // Update ElectronAsarIntegrity hash in Info.plist
  const infoPlist = path.join(resources, "..", "Info.plist");
  if (fs.existsSync(infoPlist)) {
    const asarHash = crypto.createHash("sha256").update(finalAsar).digest("hex");
    console.log("  Updating Info.plist asar integrity hash...");
    const { execSync } = require("child_process");
    execSync(`/usr/libexec/PlistBuddy -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash ${asarHash}" "${infoPlist}"`);
  }

  // Copy api-server.js to Resources
  console.log("  Installing api-server.js → Resources/");
  fs.copyFileSync(apiServerSrc, apiServerDst);

  // Re-sign the app (modifying Info.plist invalidates the code signature)
  console.log("  Re-signing app...");
  const { execSync: exec2 } = require("child_process");
  exec2(`codesign --force --deep --sign - "${path.join(resources, "..", "..")}"`, { stdio: "pipe" });
  exec2(`xattr -cr "${path.join(resources, "..", "..")}"`, { stdio: "pipe" });

  console.log("Done! app.asar patched with API server on 127.0.0.1:3456");
}

main();
