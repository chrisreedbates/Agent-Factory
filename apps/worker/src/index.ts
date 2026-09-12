import { ControlPlaneClient } from './client.js';
import { loadConfig } from './config.js';
import { JobRunner } from './handlers.js';
import { OpenAiAdapter } from './model.js';
import { WorkerRuntime } from './runtime.js';
import { Workspace } from './workspace.js';

const log = (message: string, data: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ at: new Date().toISOString(), level: 'info', message, ...data }));
};

function main(): Promise<void> | void {
  const once = process.argv.includes('--once');
  const config = loadConfig();
  const client = new ControlPlaneClient(config);
  // API mounts the artifact volume read-only; the worker owns it read/write.
  const workspace = new Workspace(config.artifactRoot, config.sourceRoot);
  const model = new OpenAiAdapter({ apiKey: config.modelApiKey, baseURL: config.modelBaseUrl, model: config.modelName });
  const runner = new JobRunner({ config, client, workspace, model, log });
  const runtime = new WorkerRuntime({ config, client, runner, log });

  log('worker starting', {
    apiBaseUrl: config.apiBaseUrl,
    workerPrincipalId: config.workerPrincipalId,
    model: config.modelName,
    artifactRoot: config.artifactRoot,
    sourceRoot: config.sourceRoot,
    jobKinds: config.jobKinds,
    once,
  });

  if (once) {
    return runtime.runOnce().then(worked => {
      log('single pass finished', { worked });
    });
  }

  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => controller.abort());
  }
  return runtime.runForever(controller.signal).then(() => log('worker stopped'));
}

await main();
