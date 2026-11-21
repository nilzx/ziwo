import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/** Retain exactly the tarball that passed installation and smoke checks. */
export async function retainCheckedTarball(tarball, directory, version) {
  const filename = path.basename(tarball);
  if (!/^ziwo-memory-[0-9A-Za-z.-]+\.tgz$/.test(filename)) throw new Error("Unexpected package filename");
  const bytes = await readFile(tarball);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  await mkdir(directory, { recursive: true });
  await copyFile(tarball, path.join(directory, filename), constants.COPYFILE_EXCL);
  await writeFile(path.join(directory, "SHA256SUMS"), `${sha256}  ${filename}\n`, { flag: "wx" });
  const metadata = { name: "@ziwo/memory", version, filename, sha256, integrity, bytes: bytes.length };
  await writeFile(path.join(directory, "artifact-metadata.json"), JSON.stringify(metadata, null, 2) + "\n", { flag: "wx" });
  return metadata;
}
