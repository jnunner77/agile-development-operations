import fs from 'node:fs';

/**
 * Write a file of secrets atomically and readable by the server's user only: write a temporary
 * file, then rename it over the original.
 */
export function writeSecretFile(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function readJsonFile(file: string): unknown {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
}
