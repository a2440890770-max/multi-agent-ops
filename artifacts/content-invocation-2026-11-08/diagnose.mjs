import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createContentModelOptions } from '../../agent/src/content-model-config.ts';

const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
let connection;
try {
  connection = createContentModelOptions(process.env);
} catch {
  console.log(JSON.stringify({ phase: 'local_model_configuration', valid: false }));
}
// Read-only account/model discovery. Never print headers, credentials or body text.
if (connection)
  try {
    const accountUrl =
      connection.provider === 'bailian'
        ? `${new URL(connection.baseUrl).origin}/compatible-mode/v1/models`
        : 'https://api.deepseek.com/models';
    const response = await fetch(accountUrl, {
      headers: { Authorization: `Bearer ${connection.options.env.ANTHROPIC_AUTH_TOKEN}` },
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => ({}));
    const ids = Array.isArray(body.data)
      ? body.data.flatMap((item) =>
          typeof item.id === 'string' && /^[a-z0-9._-]+$/i.test(item.id) ? [item.id] : [],
        )
      : [];
    console.log(
      JSON.stringify({
        phase: 'provider_account_check',
        status: response.status,
        provider: connection.provider,
        configuredModel: connection.options.model,
        availableModels: ids,
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        phase: 'provider_account_check',
        name: error.name,
        code: error.cause?.code,
      }),
    );
  }

// Start the real SDK only after local model validation, without a user turn.
if (connection) {
  const directory = await mkdtemp(join(tmpdir(), 'content-sdk-diagnostic-'));
  const controller = new AbortController();
  let stderrCount = 0;
  const categories = new Set();
  const base = connection.options;
  const timer = setTimeout(() => controller.abort(), 20000);
  const stopped = new Promise((_, reject) =>
    controller.signal.addEventListener('abort', () => reject(new Error('INIT_TIMEOUT')), {
      once: true,
    }),
  );
  void stopped.catch(() => {});
  let session;
  try {
    async function* noUserTurn() {
      await new Promise((resolve) =>
        controller.signal.addEventListener('abort', resolve, { once: true }),
      );
      yield* [];
    }
    session = query({
      prompt: noUserTurn(),
      options: {
        ...base,
        cwd: directory,
        abortController: controller,
        env: {
          ...base.env,
          CLAUDE_CONFIG_DIR: join(directory, 'config'),
          CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1',
        },
        debug: true,
        stderr(chunk) {
          stderrCount += 1;
          for (const [name, pattern] of [
            ['git_bash', /git.bash|bash.exe/i],
            ['network', /ENOTFOUND|ECONN|network|fetch failed/i],
            ['permission', /EACCES|EPERM|permission denied/i],
            ['auth', /unauthorized|authentication|401|403/i],
            ['initialization', /initialize|startup|boot/i],
            ['error', /error|failed|exception/i],
          ])
            if (pattern.test(chunk)) categories.add(name);
        },
      },
    });
    const initialized = await Promise.race([session.initializationResult(), stopped]);
    console.log(
      JSON.stringify({
        phase: 'sdk_initialization',
        initialized: Boolean(initialized),
        stderrCount,
        categories: [...categories],
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        phase: 'sdk_initialization',
        initialized: false,
        timeout: controller.signal.aborted,
        errorName: error.name,
        stderrCount,
        categories: [...categories],
      }),
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
    await Promise.allSettled([
      Promise.resolve().then(() => session?.close()),
      rm(directory, { recursive: true, force: true }),
    ]);
  }
}
