import { registryPathIn, resolveConfigDir } from '../server/configDir.ts';
import { runCli } from './commands.ts';

// pnpm runs scripts from the package directory; INIT_CWD is where the user
// actually typed `pnpm radar add .`.
const exitCode = await runCli(process.argv.slice(2), {
  cwd: process.env.INIT_CWD ?? process.cwd(),
  registryPath: registryPathIn(resolveConfigDir()),
  out: line => console.log(line),
  err: line => console.error(line),
});
process.exit(exitCode);
