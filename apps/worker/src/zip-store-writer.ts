import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const ZIP32 = 0xffff_ffff;
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
const crc32Update = (data: Uint8Array, seed: number): number => { let c = seed; for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return c >>> 0; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };

type Chunk = Uint8Array | string;
type Entry = { name: Buffer; crc: number; size: number; offset: number };

/** Minimal ZIP32 STORE writer. It deliberately does not implement compression or ZIP64. */
export class ZipStoreWriter {
  private constructor(private readonly outputPath: string, private readonly tempPath: string, private readonly handle: FileHandle, private offset = 0, private readonly entries: Entry[] = [], private readonly names = new Set<string>()) {}

  static async create(outputPath: string): Promise<ZipStoreWriter> {
    try { await fs.access(outputPath); throw new Error(`refusing to overwrite existing file: ${outputPath}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const tempPath = `${outputPath}.tmp-${randomBytes(8).toString("hex")}`;
    const handle = await fs.open(tempPath, "wx", 0o600);
    return new ZipStoreWriter(outputPath, tempPath, handle);
  }

  async addEntry(name: string, chunks: AsyncIterable<Chunk> | Iterable<Chunk>): Promise<void> {
    const nameBytes = Buffer.from(name, "utf8");
    const parts = name.split("/");
    if (!name || nameBytes.length > 0xffff || name.startsWith("/") || name.includes("\\") || parts.some((part) => !part || part === "." || part === ".." || /[:\u0000-\u001F\u007F]/u.test(part))) throw new Error("invalid ZIP entry name");
    if (this.names.has(name)) throw new Error(`duplicate ZIP entry: ${name}`); this.names.add(name);
    const localOffset = this.offset;
    if (localOffset >= ZIP32) throw new Error("ZIP32 local offset overflow");
    await this.write(Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]), u16(20), u16(0x808), u16(0), u16(0), u16(0), u32(0), u32(0), u32(0), u16(nameBytes.length), u16(0), nameBytes]));
    let crc = 0xffffffff; let size = 0;
    for await (const chunk of chunks) { const data = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk); size += data.length; if (size >= ZIP32) throw new Error("ZIP32 entry size overflow"); crc = crc32Update(data, crc); await this.write(data); }
    const finalCrc = (crc ^ 0xffffffff) >>> 0;
    await this.write(Buffer.concat([Buffer.from([0x50,0x4b,0x07,0x08]), u32(finalCrc), u32(size), u32(size)]));
    this.entries.push({ name: nameBytes, crc: finalCrc, size, offset: localOffset });
  }

  async close(): Promise<void> {
    try {
      const centralOffset = this.offset;
      for (const entry of this.entries) {
        await this.write(Buffer.concat([Buffer.from([0x50,0x4b,0x01,0x02]), u16(20), u16(20), u16(0x808), u16(0), u16(0), u16(0), u32(entry.crc), u32(entry.size), u32(entry.size), u16(entry.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(entry.offset), entry.name]));
      }
      const centralSize = this.offset - centralOffset;
      if (this.entries.length >= 0xffff || centralOffset >= ZIP32 || centralSize >= ZIP32) throw new Error("ZIP32 central directory overflow");
      await this.write(Buffer.concat([Buffer.from([0x50,0x4b,0x05,0x06]), u16(0), u16(0), u16(this.entries.length), u16(this.entries.length), u32(centralSize), u32(centralOffset), u16(0)]));
      await this.handle.sync(); await this.handle.close();
      await fs.link(this.tempPath, this.outputPath);
      try { await fs.unlink(this.tempPath); } catch { /* published output is already complete; orphan temp is harmless and recoverable */ }
    } catch (error) { await this.abort(); throw error; }
  }

  async abort(): Promise<void> { try { await this.handle.close(); } catch {} await fs.rm(this.tempPath, { force: true }); }
  private async write(data: Buffer): Promise<void> { if (this.offset + data.length >= ZIP32) throw new Error("ZIP32 archive overflow"); let written = 0; while (written < data.length) { const result = await this.handle.write(data, written, data.length - written); if (result.bytesWritten === 0) throw new Error("ZIP writer made no progress"); written += result.bytesWritten; } this.offset += data.length; }
}
