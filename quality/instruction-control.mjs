import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstructionControls } from './instruction.mjs';

export { runInstructionControls };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runInstructionControls(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`instruction controls failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
