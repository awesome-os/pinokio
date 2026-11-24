import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const DEFAULT_CAS_INDEX_URL =
  'https://raw.githubusercontent.com/awesome-os/b8g-ghost/main/manifests/index.json';
export const DEFAULT_CAS_RELEASE_BASE_URL =
  'https://github.com/awesome-os/b8g-ghost/releases/download/cas-v1';

export const DEBLOATED_PYPI_PACKAGES = [
  'pillow',
  'numpy',
  'safetensors',
  'tokenizers',
  'tiktoken',
  'pydantic-core',
  'orjson',
  'cryptography',
  'lxml',
] as const;

export type DebloatedPypiPackage = (typeof DEBLOATED_PYPI_PACKAGES)[number];

export type CasIndexEntry = {
  filename: string;
  sha256: string;
  bytes: number;
  category: string;
  version?: string;
  download_url: string;
};

export type CasIndex = {
  schema: string;
  cas_base_url: string;
  baseline_tag?: string;
  updated_at?: string;
  total_entries: number;
  entries: Record<string, CasIndexEntry>;
};

export type CasHit = {
  spec: string;
  normalizedName: string;
  entry: CasIndexEntry;
};

export type InterceptResult = {
  intercepted: boolean;
  installer: 'pip' | 'conda' | null;
  originalCommand: string;
  rewrittenCommand: string | null;
  casHits: CasHit[];
  passthrough: string[];
  hydratedEntries: CasIndexEntry[];
  ghostAbi: CasIndexEntry | null;
};

export type HydrateOptions = {
  cacheDir?: string;
  dryRun?: boolean;
};

export type HydratedArtifact = {
  entry: CasIndexEntry;
  cachePath: string;
  sha256: string;
  bytes: number;
  cached: boolean;
  dryRun: boolean;
};

const PACKAGE_ALIASES: Record<string, string> = {
  pil: 'pillow',
  pydantic_core: 'pydantic-core',
};

/**
 * PEP 503 package name normalization + common Pinokio alias mapping.
 */
export function normalizePackageName(spec: string): string {
  const cleaned = spec.trim().replace(/^["']|["']$/g, '');
  const withoutExtras = cleaned.split('[')[0] ?? cleaned;
  const baseName = withoutExtras.split(/(?:===|==|~=|!=|<=|>=|<|>|@)/)[0] ?? withoutExtras;
  const normalized = baseName.trim().toLowerCase().replace(/[-_.]+/g, '-');
  return PACKAGE_ALIASES[normalized] ?? normalized;
}

/**
 * Fetch the live `awesome-os/b8g-ghost` `cas-v1` CAS index manifest.
 */
export async function fetchCasIndex(indexUrl = DEFAULT_CAS_INDEX_URL): Promise<CasIndex> {
  const response = await fetch(indexUrl, {
    headers: { 'user-agent': '@awesome-os/pinokio/0.1.0' },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch b8g-ghost CAS index (${response.status}): ${indexUrl}`);
  }
  const data = (await response.json()) as CasIndex;
  if (!data || typeof data !== 'object' || !data.entries) {
    throw new Error(`Invalid b8g-ghost CAS index payload from ${indexUrl}`);
  }
  return data;
}

/**
 * Resolve the platform-specific `b8g-ghost-abi` (`B8G_ARENA_V1`) N-API addon from the CAS index.
 */
export function resolveGhostAbi(
  index: CasIndex,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CasIndexEntry | null {
  let targetKey = 'b8g-ghost-abi-linux-x64.node';
  if (platform === 'win32') {
    targetKey = 'b8g-ghost-abi-win64.node';
  } else if (platform === 'darwin') {
    targetKey = 'b8g-ghost-abi-macos-arm64.node';
  } else if (arch === 'arm64') {
    targetKey = 'b8g-ghost-abi-linux-arm64.node';
  }
  return index.entries[targetKey] ?? null;
}

/**
 * Resolve a Python package name against the `pypi-llm-stack` entries in `cas-v1`.
 */
export function resolveCasPythonPackage(spec: string, index: CasIndex): CasIndexEntry | null {
  const normalized = normalizePackageName(spec);
  if (!normalized) return null;

  for (const [key, entry] of Object.entries(index.entries)) {
    if (entry.category !== 'pypi-llm-stack') continue;
    const filename = (entry.filename || key).toLowerCase();
    // Matches `<pkg>-<version>.ghost.tar.gz`
    const prefix = `${normalized}-`;
    if (filename.startsWith(prefix) && /^\d/.test(filename.slice(prefix.length))) {
      return entry;
    }
  }
  return null;
}

function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cmd)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

const FLAGS_WITH_VALUE = new Set([
  '-c',
  '--channel',
  '-n',
  '--name',
  '-p',
  '--prefix',
  '-i',
  '--index-url',
  '--extra-index-url',
  '-f',
  '--find-links',
  '-r',
  '--requirement',
  '-t',
  '--target',
  '--platform',
  '--python-version',
  '--cache-dir',
]);

/**
 * Intercepts standard Pinokio `pip install <pkg...>` and `conda install <pkg...>` commands,
 * mapping matching packages to debloated `awesome-os/b8g-ghost @ cas-v1` wheels + `b8g-ghost-abi`.
 */
export function interceptPipCommand(cmd: string, index: CasIndex): InterceptResult {
  const trimmed = cmd.trim();
  const tokens = tokenizeCommand(trimmed);
  const ghostAbi = resolveGhostAbi(index);

  if (tokens.length < 3) {
    return {
      intercepted: false,
      installer: null,
      originalCommand: cmd,
      rewrittenCommand: cmd,
      casHits: [],
      passthrough: [],
      hydratedEntries: [],
      ghostAbi,
    };
  }

  let installer: 'pip' | 'conda' | null = null;
  let installIndex = -1;

  const first = path.basename(tokens[0] ?? '').toLowerCase().replace(/\.exe$/, '');
  const second = (tokens[1] ?? '').toLowerCase();
  const third = (tokens[2] ?? '').toLowerCase();
  const fourth = (tokens[3] ?? '').toLowerCase();

  if ((first === 'pip' || first === 'pip3') && second === 'install') {
    installer = 'pip';
    installIndex = 1;
  } else if (
    (first === 'python' || first === 'python3' || first === 'py') &&
    second === '-m' &&
    (third === 'pip' || third === 'pip3') &&
    fourth === 'install'
  ) {
    installer = 'pip';
    installIndex = 3;
  } else if (first === 'uv' && second === 'pip' && third === 'install') {
    installer = 'pip';
    installIndex = 2;
  } else if ((first === 'conda' || first === 'mamba' || first === 'micromamba') && second === 'install') {
    installer = 'conda';
    installIndex = 1;
  }

  if (!installer || installIndex < 0) {
    return {
      intercepted: false,
      installer: null,
      originalCommand: cmd,
      rewrittenCommand: cmd,
      casHits: [],
      passthrough: [],
      hydratedEntries: [],
      ghostAbi,
    };
  }

  const prefixTokens = tokens.slice(0, installIndex + 1);
  const argTokens = tokens.slice(installIndex + 1);

  const retainedFlags: string[] = [];
  const casHits: CasHit[] = [];
  const passthrough: string[] = [];
  const hydratedEntries: CasIndexEntry[] = [];
  const seenEntries = new Set<string>();

  for (let i = 0; i < argTokens.length; i += 1) {
    const token = argTokens[i] ?? '';
    if (!token) continue;

    if (token.startsWith('-')) {
      retainedFlags.push(token);
      if (FLAGS_WITH_VALUE.has(token) && i + 1 < argTokens.length) {
        retainedFlags.push(argTokens[i + 1] ?? '');
        i += 1;
      }
      continue;
    }

    // URLs, local paths, or editable specs pass through untouched.
    if (
      token.startsWith('http://') ||
      token.startsWith('https://') ||
      token.startsWith('git+') ||
      token.startsWith('.') ||
      token.startsWith('/') ||
      token.includes('::')
    ) {
      passthrough.push(token);
      continue;
    }

    const entry = resolveCasPythonPackage(token, index);
    if (entry) {
      const normalizedName = normalizePackageName(token);
      casHits.push({ spec: token, normalizedName, entry });
      if (!seenEntries.has(entry.sha256)) {
        seenEntries.add(entry.sha256);
        hydratedEntries.push(entry);
      }
    } else {
      passthrough.push(token);
    }
  }

  if (casHits.length === 0) {
    return {
      intercepted: false,
      installer,
      originalCommand: cmd,
      rewrittenCommand: cmd,
      casHits: [],
      passthrough,
      hydratedEntries: [],
      ghostAbi,
    };
  }

  if (ghostAbi && !seenEntries.has(ghostAbi.sha256)) {
    seenEntries.add(ghostAbi.sha256);
    hydratedEntries.push(ghostAbi);
  }

  const rewrittenCommand =
    passthrough.length > 0
      ? [...prefixTokens, ...retainedFlags, ...passthrough].join(' ')
      : null;

  return {
    intercepted: true,
    installer,
    originalCommand: cmd,
    rewrittenCommand,
    casHits,
    passthrough,
    hydratedEntries,
    ghostAbi,
  };
}

export function getDefaultCasCacheDir(): string {
  return path.join(os.homedir(), '.b8g', 'cas', 'wheels');
}

/**
 * Hydrate a `cas-v1` wheel or N-API ghost artifact into `~/.b8g/cas/wheels/<sha256>/<filename>`
 * with strict SHA-256 content verification.
 */
export async function hydrateCasWheel(
  entry: CasIndexEntry,
  options: HydrateOptions = {},
): Promise<HydratedArtifact> {
  const cacheRoot = options.cacheDir ?? getDefaultCasCacheDir();
  const targetDir = path.join(cacheRoot, entry.sha256);
  const cachePath = path.join(targetDir, entry.filename);

  if (options.dryRun) {
    return {
      entry,
      cachePath,
      sha256: entry.sha256,
      bytes: entry.bytes,
      cached: false,
      dryRun: true,
    };
  }

  try {
    const existing = await fs.readFile(cachePath);
    const existingHash = crypto.createHash('sha256').update(existing).digest('hex');
    if (existingHash === entry.sha256) {
      return {
        entry,
        cachePath,
        sha256: existingHash,
        bytes: existing.byteLength,
        cached: true,
        dryRun: false,
      };
    }
  } catch {
    // Cache miss — proceed to download from cas-v1 release
  }

  const downloadUrl =
    entry.download_url || `${DEFAULT_CAS_RELEASE_BASE_URL}/${entry.sha256}`;
  const response = await fetch(downloadUrl, {
    headers: { 'user-agent': '@awesome-os/pinokio/0.1.0' },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to hydrate CAS artifact ${entry.filename} (${response.status}): ${downloadUrl}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
  if (actualHash !== entry.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${entry.filename}: expected ${entry.sha256}, got ${actualHash}`,
    );
  }

  await fs.mkdir(targetDir, { recursive: true });
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, buffer);
  await fs.rename(tmpPath, cachePath);

  return {
    entry,
    cachePath,
    sha256: actualHash,
    bytes: buffer.byteLength,
    cached: false,
    dryRun: false,
  };
}
