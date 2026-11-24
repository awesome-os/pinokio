#!/usr/bin/env node
import {
  PINOKIO_VERSION,
  getDefaultSectiumPipePath,
  inspectRecipe,
  runRecipe,
} from './index.mts';

function printHelp(): void {
  console.log(`@awesome-os/pinokio v${PINOKIO_VERSION}
Pinokio Virtual PC recipe runner on b8g-ghost cas-v1 + Sectium Display

Usage:
  pinokio run <recipe.json> [--dry-run] [--hydrate] [--json]
  pinokio inspect <recipe.json> [--json]
  pinokio --version
  pinokio --help

Sectium Device Pipe: ${getDefaultSectiumPipePath()}`);
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`@awesome-os/pinokio ${PINOKIO_VERSION} (b8g-ghost cas-v1 + Sectium Display)`);
    return 0;
  }

  const command = args[0];
  const target = args[1];
  const asJson = args.includes('--json');

  if (command === 'inspect') {
    if (!target) {
      console.error('Error: missing <recipe.json> path for "pinokio inspect"');
      return 1;
    }
    const report = await inspectRecipe(target);
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Recipe: ${report.recipePath}`);
      console.log(`Steps: ${report.stepCount} (${report.shellCommands} shell commands)`);
      console.log(
        `CAS Hits: ${report.totalCasHits} | Passthrough: ${report.totalPassthrough} | Conda Eliminated: ${report.estimatedCondaEliminated}`,
      );
      for (const item of report.interceptions) {
        const hitNames = item.casHits.map((h) => `${h.normalizedName} -> ${h.entry.filename}`);
        console.log(`  - ${item.originalCommand}`);
        if (hitNames.length > 0) {
          console.log(`    cas-v1 hits: ${hitNames.join(', ')}`);
        }
        if (item.passthrough.length > 0) {
          console.log(`    passthrough: ${item.passthrough.join(', ')}`);
        }
      }
    }
    return 0;
  }

  if (command === 'run') {
    if (!target) {
      console.error('Error: missing <recipe.json> path for "pinokio run"');
      return 1;
    }
    const dryRun = args.includes('--dry-run');
    const hydrate = args.includes('--hydrate');
    const result = await runRecipe(target, {
      dryRun,
      hydrate: dryRun ? hydrate : true,
      onEvent: asJson
        ? undefined
        : (ev) => {
            if (ev.type === 'cas:hit') {
              const pkgs = ev.result.casHits.map((h) => h.entry.filename).join(', ');
              console.log(`[cas-v1] Intercepted (${ev.result.installer}): ${pkgs}`);
            } else if (ev.type === 'notify') {
              console.log(`[notify] ${ev.html ?? ev.text ?? ''}`);
            } else if (ev.type === 'log') {
              console.log(`[log] ${ev.message}`);
            }
          },
    });
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `Done (${result.dryRun ? 'dry-run' : 'live'}): ${result.steps.length} steps, ${result.totalCasHits} cas-v1 hits, ${result.totalPassthrough} passthrough`,
      );
    }
    return result.ok ? 0 : 1;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  return 1;
}

const exitCode = await main(process.argv);
process.exitCode = exitCode;
