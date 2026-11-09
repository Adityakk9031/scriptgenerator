import { EnvError, loadEnv } from '../config/env';
import { createApp } from './app';

let config;
try {
  config = loadEnv();
} catch (e) {
  console.error(e instanceof EnvError ? `\n${e.message}\n` : (e as Error).message);
  process.exit(1);
}

createApp(config).listen(config.port, () => {
  console.log(`ScriptGen server listening on http://localhost:${config.port}`);
});
