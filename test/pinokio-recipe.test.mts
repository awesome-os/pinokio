import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEBLOATED_PYPI_PACKAGES,
  PINOKIO_VERSION,
  SectiumPinokioSurface,
  fetchCasIndex,
  getDefaultSectiumPipePath,
  interceptPipCommand,
  interpolateTemplate,
  resolveCasPythonPackage,
  resolveGhostAbi,
  runRecipe,
  type CasIndex,
} from '../src/index.mts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const EXAMPLE_RECIPE = path.join(REPO_ROOT, 'examples', 'llm-app', 'install.json');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.mts');

let cachedLiveIndex: CasIndex | null = null;
async function getLiveCasIndex(): Promise<CasIndex> {
  if (!cachedLiveIndex) {
    cachedLiveIndex = await fetchCasIndex();
  }
  return cachedLiveIndex;
}

test('live cas-v1 index resolves all 9 debloated Python LLM stack packages + b8g-ghost-abi', async () => {
  const index = await getLiveCasIndex();
  assert.equal(index.schema, 'b8g-ghost-cas-index-v1');
  assert.ok(index.total_entries > 0, 'index should contain CAS entries');

  for (const pkg of DEBLOATED_PYPI_PACKAGES) {
    const entry = resolveCasPythonPackage(pkg, index);
    assert.ok(entry, `expected cas-v1 entry for ${pkg}`);
    assert.equal(entry.category, 'pypi-llm-stack');
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(entry.bytes > 0, `expected non-zero size for ${pkg}`);
    assert.ok(
      entry.download_url.includes('/releases/download/cas-v1/'),
      `expected cas-v1 release URL for ${pkg}`,
    );
  }

  const winAbi = resolveGhostAbi(index, 'win32', 'x64');
  const linuxX64Abi = resolveGhostAbi(index, 'linux', 'x64');
  const linuxArmAbi = resolveGhostAbi(index, 'linux', 'arm64');
  const macAbi = resolveGhostAbi(index, 'darwin', 'arm64');

  assert.equal(winAbi?.filename, 'b8g-ghost-abi-win64.node');
  assert.equal(linuxX64Abi?.filename, 'b8g-ghost-abi-linux-x64.node');
  assert.equal(linuxArmAbi?.filename, 'b8g-ghost-abi-linux-arm64.node');
  assert.equal(macAbi?.filename, 'b8g-ghost-abi-macos-arm64.node');
});

test('interceptPipCommand maps pip/conda installs to cas-v1 and preserves passthrough packages', async () => {
  const index = await getLiveCasIndex();

  const fullHit = interceptPipCommand(
    'pip install numpy>=2.0 Pillow==13.0.0 pydantic_core tokenizers safetensors',
    index,
  );
  assert.equal(fullHit.intercepted, true);
  assert.equal(fullHit.installer, 'pip');
  assert.equal(fullHit.casHits.length, 5);
  assert.deepEqual(fullHit.passthrough, []);
  assert.equal(fullHit.rewrittenCommand, null);
  assert.ok(fullHit.hydratedEntries.length >= 5);
  assert.ok(fullHit.ghostAbi, 'expected b8g-ghost-abi to be attached');

  const mixedHit = interceptPipCommand(
    'conda install -y -c conda-forge PIL tiktoken orjson accelerate',
    index,
  );
  assert.equal(mixedHit.intercepted, true);
  assert.equal(mixedHit.installer, 'conda');
  assert.deepEqual(
    mixedHit.casHits.map((h) => h.normalizedName),
    ['pillow', 'tiktoken', 'orjson'],
  );
  assert.deepEqual(mixedHit.passthrough, ['accelerate']);
  assert.equal(mixedHit.rewrittenCommand, 'conda install -y -c conda-forge accelerate');

  const nonInstall = interceptPipCommand('python app.py --port 7860', index);
  assert.equal(nonInstall.intercepted, false);
  assert.equal(nonInstall.casHits.length, 0);
  assert.equal(nonInstall.rewrittenCommand, 'python app.py --port 7860');
});

test('runRecipe executes examples/llm-app/install.json with 9/9 live cas-v1 hits and zero conda bloat', async () => {
  const index = await getLiveCasIndex();
  const events: string[] = [];

  const result = await runRecipe(EXAMPLE_RECIPE, {
    dryRun: true,
    casIndex: index,
    onEvent: (ev) => events.push(ev.type),
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.steps.length, 3);
  assert.equal(result.totalCasHits, 9);
  assert.equal(result.totalPassthrough, 0);
  assert.equal(result.local.app_name, 'awesome-llm-studio');
  assert.equal(result.local.model_family, 'llama-3.2-1b');
  assert.equal(result.notifications.length, 1);
  assert.equal(
    result.notifications[0]?.html,
    'awesome-llm-studio (llama-3.2-1b) ready via b8g-ghost cas-v1 zero-conda hydration!',
  );
  assert.ok(events.includes('cas:hit'));
  assert.ok(events.includes('notify'));

  const shellTrace = result.steps[1];
  assert.equal(shellTrace?.method, 'shell.run');
  assert.equal(shellTrace?.interceptions?.length, 2);
  assert.equal(shellTrace?.interceptions?.[0]?.rewrittenCommand, null);
  assert.equal(shellTrace?.interceptions?.[1]?.rewrittenCommand, null);
});

test('local.set template interpolation and script.start sub-recipe execution work end-to-end', async () => {
  const interpolated = interpolateTemplate(
    {
      banner: 'Hello {{local.name}} on {{platform}}',
      nested: ['{{local.count}}', '{{env.TEST_KEY}}'],
    },
    {
      local: { name: 'Pinokio', count: 42 },
      env: { TEST_KEY: 'cas-v1' },
      cwd: '/tmp',
      platform: 'linux',
      arch: 'x64',
    },
  );
  assert.equal(interpolated.banner, 'Hello Pinokio on linux');
  assert.deepEqual(interpolated.nested, [42, 'cas-v1']);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-pinokio-test-'));
  try {
    const subRecipePath = path.join(tmpDir, 'sub.json');
    const mainRecipePath = path.join(tmpDir, 'main.json');

    await fs.writeFile(
      subRecipePath,
      JSON.stringify({
        run: [
          { method: 'local.set', params: { sub_status: 'hydrated-{{local.target}}' } },
          { method: 'log', params: { text: 'Sub-recipe ran for {{local.target}}' } },
        ],
      }),
      'utf8',
    );

    await fs.writeFile(
      mainRecipePath,
      JSON.stringify({
        run: [
          { method: 'local.set', params: { target: 'qwen-3' } },
          { method: 'script.start', params: { uri: 'sub.json' } },
          { method: 'notify', params: { text: 'Final: {{local.sub_status}}' } },
        ],
      }),
      'utf8',
    );

    const index = await getLiveCasIndex();
    const result = await runRecipe(mainRecipePath, { dryRun: true, casIndex: index });
    assert.equal(result.ok, true);
    assert.equal(result.local.sub_status, 'hydrated-qwen-3');
    assert.deepEqual(result.logs, ['Sub-recipe ran for qwen-3']);
    assert.equal(result.notifications[0]?.text, 'Final: hydrated-qwen-3');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('SectiumPinokioSurface targets canonical Sectium Device Pipe with dual NDJSON channels', () => {
  assert.equal(getDefaultSectiumPipePath('win32'), '\\\\.\\pipe\\sectium-dev');
  assert.equal(getDefaultSectiumPipePath('linux'), '/tmp/sectium-dev.sock');

  const surface = new SectiumPinokioSurface({
    pipePath: '/tmp/sectium-dev.sock',
    surfaceId: 'pinokio-test',
  });
  const displayFrame = surface.openAppSurface('llm-app', 'b8g://apps/llm-app');
  assert.equal(displayFrame.channel, 'display');
  assert.equal(displayFrame.type, 'open_surface');
  assert.equal(displayFrame.surfaceId, 'pinokio-test');

  const encoded = surface.encodeFrame(displayFrame);
  assert.ok(encoded.endsWith('\n'));
  const decoded = JSON.parse(encoded.trim()) as { channel: string; type: string };
  assert.equal(decoded.channel, 'display');
  assert.equal(decoded.type, 'open_surface');

  const markup = surface.toWebComponentMarkup();
  assert.ok(markup.includes('<b8g-sectium-command'));
  assert.ok(markup.includes('<b8g-sectium-display'));
});

test('CLI --version and inspect examples/llm-app/install.json succeed', () => {
  const versionOut = execFileSync(process.execPath, [CLI_PATH, '--version'], {
    encoding: 'utf8',
  }).trim();
  assert.ok(
    versionOut.includes(`@awesome-os/pinokio ${PINOKIO_VERSION}`),
    `unexpected --version output: ${versionOut}`,
  );

  const inspectOut = execFileSync(
    process.execPath,
    [CLI_PATH, 'inspect', EXAMPLE_RECIPE, '--json'],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(inspectOut) as {
    totalCasHits: number;
    totalPassthrough: number;
    estimatedCondaEliminated: boolean;
  };
  assert.equal(parsed.totalCasHits, 9);
  assert.equal(parsed.totalPassthrough, 0);
  assert.equal(parsed.estimatedCondaEliminated, true);
});
