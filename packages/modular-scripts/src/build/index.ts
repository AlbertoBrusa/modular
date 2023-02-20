import { paramCase as toParamCase } from 'change-case';
import chalk from 'chalk';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as minimize from 'html-minifier-terser';
import type { CoreProperties } from '@schemastore/package';
import type { ModularType } from '@modular-scripts/modular-types';

import * as logger from '../utils/logger';
import actionPreflightCheck from '../utils/actionPreflightCheck';
import { getModularType } from '../utils/packageTypes';
import getWorkspaceLocation from '../utils/getLocation';
import { selectBuildableWorkspaces } from '../utils/selectWorkspaces';
import { setupEnvForDirectory } from '../utils/setupEnv';
import determineTargetPaths from '../utils/determineTargetPaths';
import printHostingInstructions from './printHostingInstructions';
import { Asset, printFileSizesAfterBuild } from './fileSizeReporter';
import type { StatsCompilation } from 'webpack';
import { checkBrowsers } from '../utils/checkBrowsers';
import checkRequiredFiles from '../utils/checkRequiredFiles';
import createEsbuildBrowserslistTarget from '../utils/createEsbuildBrowserslistTarget';
import getClientEnvironment from '../esbuild-scripts/config/getClientEnvironment';
import {
  createSyntheticIndex,
  getEntryPoint,
  createViewTrampoline,
} from '../esbuild-scripts/api';
import {
  webpackMeasureFileSizesBeforeBuild,
  createWebpackAssets,
} from './webpackFileSizeReporter';
import {
  createEsbuildAssets,
  esbuildMeasureFileSizesBeforeBuild,
} from './esbuildFileSizeReporter';
import { getDependencyInfo } from '../utils/getDependencyInfo';
import { isReactNewApi } from '../utils/isReactNewApi';
import { getConfig } from '../utils/config';
import { getAllWorkspaces } from '../utils/getAllWorkspaces';
import buildWebpack from '../react-scripts/scripts/buildWebpack';
import getModularRoot from '../utils/getModularRoot';
import execAsync from '../utils/execAsync';

async function buildStandalone(
  target: string,
  type: Extract<ModularType, 'app' | 'esm-view'>,
) {
  // Setup Paths
  const targetDirectory = await getWorkspaceLocation(target);
  const paths = await determineTargetPaths(target);
  const isApp = type === 'app';

  const isEsbuild = getConfig('useModularEsbuild', targetDirectory);

  await checkBrowsers(targetDirectory);

  let previousFileSizes: Record<string, number>;
  if (isEsbuild) {
    previousFileSizes = await esbuildMeasureFileSizesBeforeBuild(
      paths.appBuild,
    );
  } else {
    previousFileSizes = await webpackMeasureFileSizesBeforeBuild(
      paths.appBuild,
    );
  }

  // Warn and crash if required files are missing
  isApp
    ? await checkRequiredFiles([paths.appHtml, paths.appIndexJs])
    : await checkRequiredFiles([paths.appIndexJs]);

  logger.log('Creating an optimized production build...');

  await fs.emptyDir(paths.appBuild);

  if (isApp) {
    await fs.copy(paths.appPublic, paths.appBuild, {
      dereference: true,
      filter: (file) => file !== paths.appHtml,
      overwrite: true,
    });
  }

  let assets: Asset[];
  logger.debug('Extracting dependency info from source code...');

  // Retrieve dependency info for target to inform the build process
  const {
    importMap,
    styleImports,
    packageDependencies,
    bundledDependencies,
    bundledResolutions,
    externalDependencies,
    externalResolutions,
  } = await getDependencyInfo(target);

  logger.debug(
    `These are the external dependencies and their resolutions: ${JSON.stringify(
      {
        externalDependencies,
        externalResolutions,
      },
    )}`,
  );
  logger.debug(
    `These are the bundled dependencies and their resolutions: ${JSON.stringify(
      {
        bundledDependencies,
        bundledResolutions,
      },
    )}`,
  );

  const useReactCreateRoot = isReactNewApi(externalResolutions);
  const browserTarget = createEsbuildBrowserslistTarget(targetDirectory);

  let jsEntryPoint: string | undefined;
  let cssEntryPoint: string | undefined;

  if (isEsbuild) {
    logger.debug('Building with esbuild');
    const { default: buildEsbuildApp } = await import(
      '../esbuild-scripts/build'
    );
    const result = await buildEsbuildApp(target, paths, importMap, type);
    jsEntryPoint = getEntryPoint(paths, result, '.js');
    cssEntryPoint = getEntryPoint(paths, result, '.css');
    assets = createEsbuildAssets(paths, result);
  } else {
    logger.debug('Building with Webpack');
    // create-react-app doesn't support plain module outputs yet,
    // so --preserve-modules has no effect here

    // If it's an app, set it at ESBUILD_TARGET_FACTORY or default to es2015
    // If it's not an app it's an ESM view, then we need es2020
    const esbuildTargetFactory = isApp ? browserTarget : ['es2020'];

    await buildWebpack(
      esbuildTargetFactory,
      isApp,
      importMap,
      useReactCreateRoot,
      styleImports,
      paths,
    );

    const statsFilePath = path.join(paths.appBuild, 'bundle-stats.json');

    try {
      const stats: StatsCompilation = await fs.readJson(statsFilePath);
      const mainEntrypoint = stats?.assetsByChunkName?.main;
      jsEntryPoint = mainEntrypoint?.find((entryPoint) =>
        entryPoint.endsWith('.js'),
      );
      cssEntryPoint = mainEntrypoint?.find((entryPoint) =>
        entryPoint.endsWith('.css'),
      );

      if (stats?.warnings?.length) {
        logger.log(chalk.yellow('Compiled with warnings.\n'));
        logger.log(stats.warnings.join('\n\n'));
        logger.log(
          '\nSearch for the ' +
            chalk.underline(chalk.yellow('keywords')) +
            ' to learn more about each warning.',
        );
      } else {
        logger.log(chalk.green('Compiled successfully.\n'));
      }

      assets = createWebpackAssets(paths, stats);
    } finally {
      await fs.remove(statsFilePath);
    }
  }

  // If view, write the synthetic index.html and create a trampoline file pointing to the main entrypoint
  // This is for both esbuild and webpack so it lives here. If app, instead, the public/index.html file is generated specifical in different ways.
  if (!isApp) {
    if (!jsEntryPoint) {
      throw new Error("Can't find main entrypoint after building");
    }

    // Create synthetic index
    const env = getClientEnvironment(paths.publicUrlOrPath.slice(0, -1));
    const html = createSyntheticIndex({
      cssEntryPoint,
      replacements: env.raw,
      styleImports,
    });
    await fs.writeFile(
      path.join(paths.appBuild, 'index.html'),
      await minimize.minify(html, {
        html5: true,
        collapseBooleanAttributes: true,
        collapseWhitespace: true,
        collapseInlineTagWhitespace: true,
        decodeEntities: true,
        minifyCSS: true,
        minifyJS: true,
        removeAttributeQuotes: false,
        removeComments: true,
        removeTagWhitespace: true,
      }),
    );

    // Create and write trampoline file
    const trampolineContent = createViewTrampoline({
      fileName: path.basename(jsEntryPoint),
      importMap,
      useReactCreateRoot,
    });

    const trampolinePath = `${paths.appBuild}/static/js/_trampoline.js`;
    await fs.writeFile(trampolinePath, trampolineContent);
  }

  // Add dependencies from source and bundled dependencies to target package.json
  const targetPackageJson = (await fs.readJSON(
    path.join(targetDirectory, 'package.json'),
  )) as CoreProperties;
  // Copy selected fields of package.json over
  fs.writeJSON(
    path.join(paths.appBuild, 'package.json'),
    {
      name: targetPackageJson.name,
      version: targetPackageJson.version,
      license: targetPackageJson.license,
      modular: targetPackageJson.modular,
      dependencies: packageDependencies,
      bundledDependencies: isApp
        ? Object.keys(packageDependencies)
        : Object.keys(bundledResolutions),
      module: jsEntryPoint ? paths.publicUrlOrPath + jsEntryPoint : undefined,
      style: cssEntryPoint ? paths.publicUrlOrPath + cssEntryPoint : undefined,
      styleImports: styleImports?.size ? [...styleImports] : undefined,
    },
    { spaces: 2 },
  );

  printFileSizesAfterBuild(assets, previousFileSizes);

  printHostingInstructions(
    target,
    paths.publicUrlOrPath,
    paths.publicUrlOrPath,
    paths.appBuild,
  );
}

async function build({
  packagePaths,
  preserveModules = true,
  private: includePrivate,
  ancestors,
  descendants,
  changed,
  compareBranch,
  dangerouslyIgnoreCircularDependencies,
}: {
  packagePaths: string[];
  preserveModules: boolean;
  private: boolean;
  ancestors: boolean;
  descendants: boolean;
  changed: boolean;
  compareBranch?: string;
  dangerouslyIgnoreCircularDependencies: boolean;
}): Promise<void> {
  const isSelective =
    changed || ancestors || descendants || packagePaths.length;

  const modularRoot = getModularRoot();
  const [allWorkspacePackages] = await getAllWorkspaces(modularRoot);

  // targets are either the set of what's specified in the selective options or all the packages in the monorepo
  const targets = isSelective ? packagePaths : [...allWorkspacePackages.keys()];

  const selectedTargets = await selectBuildableWorkspaces({
    targets,
    changed,
    compareBranch,
    descendants,
    ancestors,
    dangerouslyIgnoreCircularDependencies,
  });

  if (!selectedTargets.length) {
    logger.log('No workspaces to build');
    process.exit(0);
  }

  logger.debug(
    `Building the following workspaces in order: ${JSON.stringify(
      selectedTargets,
    )}`,
  );

  for (const target of selectedTargets) {
    const packageInfo = allWorkspacePackages.get(target);

    try {
      const targetDirectory = await getWorkspaceLocation(target);
      await setupEnvForDirectory(targetDirectory);
      if (packageInfo?.modular) {
        // If it's modular, build with Modular
        const targetType = getModularType(targetDirectory);
        if (targetType === 'app' || targetType === 'esm-view') {
          await buildStandalone(target, targetType);
        } else {
          const { buildPackage } = await import('./buildPackage');
          // ^ we do a dynamic import here to defer the module's loading
          // till when it's actually needed

          await buildPackage(target, preserveModules, includePrivate);
        }
      } else {
        // Otherwise, build by running the workspace's build script
        // We're sure it's here because selectBuildableWorkspaces returns only buildable workspaces.
        await execAsync(`yarn`, ['workspace', target, 'build'], {
          cwd: modularRoot,
          log: false,
        });
      }
    } catch (err) {
      logger.error(`building ${target} failed`);
      throw err;
    }
  }
}

export default actionPreflightCheck(build);
