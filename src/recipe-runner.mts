import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  fetchCasIndex,
  hydrateCasWheel,
  interceptPipCommand,
  type CasIndex,
  type HydratedArtifact,
  type InterceptResult,
} from './cas-interceptor.mts';

export type PinokioStep = {
  id?: string;
  method: string;
  params?: Record<string, unknown>;
  when?: string | boolean;
};

export type PinokioRecipe = {
  run: PinokioStep[];
  daemon?: boolean;
  title?: string;
  description?: string;
};

export type TemplateContext = {
  local: Record<string, unknown>;
  env: Record<string, string | undefined>;
  cwd: string;
  platform: NodeJS.Platform;
  arch: string;
};

export type RecipeEvent =
  | { type: 'step:start'; index: number; method: string; params: Record<string, unknown> }
  | { type: 'step:done'; index: number; method: string; detail?: Record<string, unknown> }
  | { type: 'cas:hit'; command: string; result: InterceptResult }
  | { type: 'notify'; html?: string; text?: string; href?: string }
  | { type: 'log'; message: string }
  | { type: 'shell:output'; stream: 'stdout' | 'stderr'; chunk: string };

export type RunRecipeOptions = {
  cwd?: string;
  dryRun?: boolean;
  hydrate?: boolean;
  casIndex?: CasIndex;
  casIndexUrl?: string;
  cacheDir?: string;
  local?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  onEvent?: (event: RecipeEvent) => void;
};

export type StepTrace = {
  index: number;
  method: string;
  params: Record<string, unknown>;
  interceptions?: InterceptResult[];
  hydrated?: HydratedArtifact[];
  output?: string;
  downloadPath?: string;
  subRecipeResult?: RunRecipeResult;
};

export type RunRecipeResult = {
  ok: boolean;
  recipePath: string | null;
  dryRun: boolean;
  local: Record<string, unknown>;
  steps: StepTrace[];
  totalCasHits: number;
  totalPassthrough: number;
  notifications: Array<{ html?: string; text?: string; href?: string }>;
  logs: string[];
};

export type RecipeInspection = {
  recipePath: string | null;
  stepCount: number;
  shellCommands: number;
  interceptions: InterceptResult[];
  totalCasHits: number;
  totalPassthrough: number;
  estimatedCondaEliminated: boolean;
};

function resolveDotPath(root: Record<string, unknown>, keyPath: string): unknown {
  const segments = keyPath.split('.');
  let current: unknown = root;
  for (const segment of segments) {
    if (current && typeof current === 'object' && segment in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Interpolates Pinokio `{{local.x}}`, `{{env.X}}`, `{{platform}}`, `{{arch}}`, `{{cwd}}`
 * placeholders across strings, arrays, and plain objects.
 */
export function interpolateTemplate<T>(value: T, ctx: TemplateContext): T {
  if (typeof value === 'string') {
    const scope: Record<string, unknown> = {
      local: ctx.local,
      env: ctx.env,
      cwd: ctx.cwd,
      platform: ctx.platform,
      arch: ctx.arch,
    };
    const exactMatch = value.match(/^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/);
    if (exactMatch) {
      const resolved = resolveDotPath(scope, exactMatch[1] ?? '');
      if (resolved !== undefined) {
        return resolved as T;
      }
    }
    const replaced = value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (raw, expr: string) => {
      const resolved = resolveDotPath(scope, expr);
      return resolved === undefined ? raw : String(resolved);
    });
    return replaced as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateTemplate(item, ctx)) as T;
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateTemplate(v, ctx);
    }
    return out as T;
  }

  return value;
}

/**
 * Loads a Pinokio recipe from `.json`, `.js`, `.mjs`, or `.mts`.
 */
export async function loadRecipe(recipePath: string): Promise<PinokioRecipe> {
  const absolute = path.resolve(recipePath);
  if (absolute.endsWith('.json')) {
    const raw = await fs.readFile(absolute, 'utf8');
    const parsed = JSON.parse(raw) as PinokioRecipe;
    if (!parsed || !Array.isArray(parsed.run)) {
      throw new Error(`Invalid Pinokio JSON recipe (missing "run" array): ${absolute}`);
    }
    return parsed;
  }

  const mod = (await import(pathToFileURL(absolute).href)) as {
    default?: PinokioRecipe | ((kernel?: unknown) => PinokioRecipe | Promise<PinokioRecipe>);
    run?: PinokioStep[];
  };
  const exported = mod.default ?? mod;
  const resolved = typeof exported === 'function' ? await exported({}) : exported;
  if (!resolved || !Array.isArray(resolved.run)) {
    throw new Error(`Invalid Pinokio JS recipe (missing "run" array): ${absolute}`);
  }
  return resolved;
}

async function execShellCommand(
  command: string,
  cwd: string,
  env: Record<string, string | undefined>,
  onEvent?: (event: RecipeEvent) => void,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let combined = '';
    child.stdout?.on('data', (buf: Buffer) => {
      const chunk = buf.toString('utf8');
      combined += chunk;
      onEvent?.({ type: 'shell:output', stream: 'stdout', chunk });
    });
    child.stderr?.on('data', (buf: Buffer) => {
      const chunk = buf.toString('utf8');
      combined += chunk;
      onEvent?.({ type: 'shell:output', stream: 'stderr', chunk });
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(combined);
      } else {
        reject(new Error(`Shell command failed (exit ${code ?? -1}): ${command}\n${combined}`));
      }
    });
  });
}

async function downloadWithCasCache(
  uri: string,
  destDir: string,
  dryRun: boolean,
): Promise<string> {
  const filename = path.basename(new URL(uri).pathname) || 'download.bin';
  const cacheRoot = path.join(os.homedir(), '.b8g', 'cas', 'downloads');
  const targetPath = path.join(destDir, filename);

  if (dryRun) {
    return targetPath;
  }

  const response = await fetch(uri, {
    headers: { 'user-agent': '@awesome-os/pinokio/0.1.0' },
  });
  if (!response.ok) {
    throw new Error(`fs.download failed (${response.status}): ${uri}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  const casEntryPath = path.join(cacheRoot, sha256);
  await fs.mkdir(cacheRoot, { recursive: true });
  await fs.writeFile(casEntryPath, buffer);

  await fs.mkdir(destDir, { recursive: true });
  await fs.copyFile(casEntryPath, targetPath);
  return targetPath;
}

/**
 * Inspects a Pinokio recipe against `b8g-ghost @ cas-v1` without executing commands.
 */
export async function inspectRecipe(
  recipeOrPath: string | PinokioRecipe,
  casIndex?: CasIndex,
): Promise<RecipeInspection> {
  const recipePath = typeof recipeOrPath === 'string' ? path.resolve(recipeOrPath) : null;
  const recipe = typeof recipeOrPath === 'string' ? await loadRecipe(recipeOrPath) : recipeOrPath;
  const index = casIndex ?? (await fetchCasIndex());

  const interceptions: InterceptResult[] = [];
  let shellCommands = 0;
  let totalCasHits = 0;
  let totalPassthrough = 0;

  for (const step of recipe.run) {
    if (step.method !== 'shell.run') continue;
    const rawMsg = step.params?.message;
    const commands = Array.isArray(rawMsg)
      ? rawMsg.map(String)
      : typeof rawMsg === 'string'
        ? [rawMsg]
        : [];
    for (const cmd of commands) {
      shellCommands += 1;
      const result = interceptPipCommand(cmd, index);
      interceptions.push(result);
      totalCasHits += result.casHits.length;
      totalPassthrough += result.passthrough.length;
    }
  }

  return {
    recipePath,
    stepCount: recipe.run.length,
    shellCommands,
    interceptions,
    totalCasHits,
    totalPassthrough,
    estimatedCondaEliminated: totalCasHits > 0,
  };
}

/**
 * Executes a Pinokio recipe (`run: [...]`) with automatic `b8g-ghost @ cas-v1` interception.
 */
export async function runRecipe(
  recipeOrPath: string | PinokioRecipe,
  options: RunRecipeOptions = {},
): Promise<RunRecipeResult> {
  const recipePath = typeof recipeOrPath === 'string' ? path.resolve(recipeOrPath) : null;
  const recipe = typeof recipeOrPath === 'string' ? await loadRecipe(recipeOrPath) : recipeOrPath;
  const baseCwd =
    options.cwd ?? (recipePath ? path.dirname(recipePath) : process.cwd());
  const dryRun = options.dryRun ?? false;
  const hydrate = options.hydrate ?? !dryRun;
  const casIndex = options.casIndex ?? (await fetchCasIndex(options.casIndexUrl));

  const local: Record<string, unknown> = { ...(options.local ?? {}) };
  const baseEnv: Record<string, string | undefined> = {
    ...process.env,
    ...(options.env ?? {}),
  };

  const steps: StepTrace[] = [];
  const notifications: Array<{ html?: string; text?: string; href?: string }> = [];
  const logs: string[] = [];
  let totalCasHits = 0;
  let totalPassthrough = 0;

  for (let i = 0; i < recipe.run.length; i += 1) {
    const step = recipe.run[i];
    if (!step) continue;

    const ctx: TemplateContext = {
      local,
      env: baseEnv,
      cwd: baseCwd,
      platform: process.platform,
      arch: process.arch,
    };

    const params = interpolateTemplate(step.params ?? {}, ctx);
    options.onEvent?.({ type: 'step:start', index: i, method: step.method, params });

    if (step.method === 'local.set') {
      for (const [k, v] of Object.entries(params)) {
        local[k] = v;
      }
      steps.push({ index: i, method: step.method, params });
      options.onEvent?.({ type: 'step:done', index: i, method: step.method });
      continue;
    }

    if (step.method === 'notify') {
      const note = {
        html: typeof params.html === 'string' ? params.html : undefined,
        text: typeof params.text === 'string' ? params.text : undefined,
        href: typeof params.href === 'string' ? params.href : undefined,
      };
      notifications.push(note);
      options.onEvent?.({ type: 'notify', ...note });
      steps.push({ index: i, method: step.method, params });
      options.onEvent?.({ type: 'step:done', index: i, method: step.method });
      continue;
    }

    if (step.method === 'log') {
      const msg =
        typeof params.raw === 'string'
          ? params.raw
          : typeof params.text === 'string'
            ? params.text
            : JSON.stringify(params);
      logs.push(msg);
      options.onEvent?.({ type: 'log', message: msg });
      steps.push({ index: i, method: step.method, params });
      options.onEvent?.({ type: 'step:done', index: i, method: step.method });
      continue;
    }

    if (step.method === 'fs.download') {
      const uri = String(params.uri ?? params.url ?? '');
      if (!uri) {
        throw new Error(`fs.download step ${i} missing "uri" or "url"`);
      }
      const targetDir = path.resolve(baseCwd, String(params.dir ?? params.path ?? '.'));
      const downloadPath = await downloadWithCasCache(uri, targetDir, dryRun);
      steps.push({ index: i, method: step.method, params, downloadPath });
      options.onEvent?.({
        type: 'step:done',
        index: i,
        method: step.method,
        detail: { downloadPath },
      });
      continue;
    }

    if (step.method === 'script.start') {
      const uri = String(params.uri ?? '');
      if (!uri) {
        throw new Error(`script.start step ${i} missing "uri"`);
      }
      const subPath = path.resolve(baseCwd, uri);
      const subLocal =
        params.params && typeof params.params === 'object'
          ? { ...local, ...(params.params as Record<string, unknown>) }
          : { ...local };
      const subResult = await runRecipe(subPath, {
        ...options,
        cwd: path.dirname(subPath),
        casIndex,
        local: subLocal,
      });
      Object.assign(local, subResult.local);
      totalCasHits += subResult.totalCasHits;
      totalPassthrough += subResult.totalPassthrough;
      notifications.push(...subResult.notifications);
      logs.push(...subResult.logs);
      steps.push({ index: i, method: step.method, params, subRecipeResult: subResult });
      options.onEvent?.({ type: 'step:done', index: i, method: step.method });
      continue;
    }

    if (step.method === 'shell.run') {
      const stepCwd =
        typeof params.path === 'string' ? path.resolve(baseCwd, params.path) : baseCwd;
      const venvName = typeof params.venv === 'string' ? params.venv : undefined;
      const stepEnv: Record<string, string | undefined> = {
        ...baseEnv,
        ...(params.env && typeof params.env === 'object'
          ? (params.env as Record<string, string | undefined>)
          : {}),
      };
      if (venvName) {
        const venvPath = path.resolve(stepCwd, venvName);
        stepEnv.VIRTUAL_ENV = venvPath;
        const binDir = process.platform === 'win32' ? path.join(venvPath, 'Scripts') : path.join(venvPath, 'bin');
        stepEnv.PATH = `${binDir}${path.delimiter}${stepEnv.PATH ?? ''}`;
      }

      const rawMsg = params.message;
      const commands = Array.isArray(rawMsg)
        ? rawMsg.map(String)
        : typeof rawMsg === 'string'
          ? [rawMsg]
          : [];

      const interceptions: InterceptResult[] = [];
      const hydrated: HydratedArtifact[] = [];
      let combinedOutput = '';

      for (const cmd of commands) {
        const interception = interceptPipCommand(cmd, casIndex);
        interceptions.push(interception);
        totalCasHits += interception.casHits.length;
        totalPassthrough += interception.passthrough.length;

        if (interception.intercepted) {
          options.onEvent?.({ type: 'cas:hit', command: cmd, result: interception });
          for (const entry of interception.hydratedEntries) {
            const artifact = await hydrateCasWheel(entry, {
              cacheDir: options.cacheDir,
              dryRun: dryRun || !hydrate,
            });
            hydrated.push(artifact);
          }
          stepEnv.B8G_CAS_WHEELS = hydrated.map((h) => h.cachePath).join(path.delimiter);
          if (interception.ghostAbi) {
            stepEnv.B8G_ARENA_V1 = interception.ghostAbi.sha256;
          }
        }

        const commandToRun = interception.rewrittenCommand;
        if (!commandToRun) {
          // 100% satisfied by b8g-ghost cas-v1 — zero pip/conda subprocess needed!
          continue;
        }

        if (!dryRun) {
          combinedOutput += await execShellCommand(commandToRun, stepCwd, stepEnv, options.onEvent);
        }
      }

      steps.push({
        index: i,
        method: step.method,
        params,
        interceptions,
        hydrated,
        output: combinedOutput,
      });
      options.onEvent?.({ type: 'step:done', index: i, method: step.method });
      continue;
    }

    throw new Error(`Unsupported Pinokio step method "${step.method}" at step ${i}`);
  }

  return {
    ok: true,
    recipePath,
    dryRun,
    local,
    steps,
    totalCasHits,
    totalPassthrough,
    notifications,
    logs,
  };
}
